import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {effectiveContextWindow, requireContextWindow} from '../../apps/server/src/contextWindow.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import {ModelCacheRepository} from '../../apps/server/src/modelCache.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createTestServer} from './helpers/testServer.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {
  MEASURED_AGENT_PROMPT_TOKENS,
  PI_MINIMUM_CONTEXT_TOKENS,
  maxAffordableImages,
  minimumUsableContextSize,
  replyTokenBudget,
} from '../../packages/shared/src/piContext.ts';
import {getModelsIniSectionValues, parseModelsIni} from '../../packages/shared/src/modelsIni.ts';

const MODEL = {id: 'repo/model:Q4', name: 'Model Q4'};

test('the trap this phase exists to avoid: zero is not unknown', () => {
  // `maxAffordableImages(0)` refuses every image, and `replyTokenBudget(0)`
  // quietly returns a floor. An unknown window is `null`, and coercing it to a
  // number is how Phase 4 breaks silently.
  assert.equal(maxAffordableImages(0), 0);
  assert.equal(replyTokenBudget(0), 1024);
  assert.ok(maxAffordableImages(16_384) > 0);
});

test('/props beats the configured cap, and the cap beats nothing', () => {
  const cache = (contextWindow?: number) => ({
    getModel: () => (contextWindow == null ? null : ({contextWindow} as never)),
  });

  // Never loaded, never capped.
  assert.equal(effectiveContextWindow({...MODEL, params: {extra: {}}}), null);
  assert.equal(effectiveContextWindow({...MODEL, params: {extra: {}}}, cache()), null);

  // Capped but never loaded: the cap is the best prediction Nelle has.
  assert.equal(
    effectiveContextWindow({...MODEL, params: {contextSize: 8192, extra: {}}}, cache()),
    8192,
  );

  // Loaded: llama.cpp's own answer wins, even against a cap that disagrees.
  assert.equal(
    effectiveContextWindow({...MODEL, params: {contextSize: 8192, extra: {}}}, cache(262_144)),
    262_144,
  );
});

test('Pi is never handed a window nobody measured', () => {
  assert.equal(requireContextWindow({...MODEL, params: {contextSize: 4096, extra: {}}}), 4096);
  assert.throws(
    () => requireContextWindow({...MODEL, params: {extra: {}}}),
    /Model Q4 has no known context window/,
  );
});

test('a per-model c overrides the global one, exactly as llama.cpp cascades', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  const other = await store.addHuggingFaceModel({repoId: 'repo/other', quant: 'UD-Q4_K_M'});

  // No cap anywhere: llama.cpp uses the window the model was trained for.
  assert.equal((await store.getModel(model.id))?.params.contextSize, undefined);

  await store.updateGlobalModelParams({c: '16384'});
  assert.equal((await store.getModel(model.id))?.params.contextSize, 16_384);
  assert.equal((await store.getModel(other.id))?.params.contextSize, 16_384);

  await store.updateModel(model.id, {params: {c: '32768'}});
  assert.equal((await store.getModel(model.id))?.params.contextSize, 32_768);
  assert.equal(
    (await store.getModel(other.id))?.params.contextSize,
    16_384,
    'the global still applies',
  );

  // `c = 0` is llama.cpp's own way of saying "loaded from model": not a cap.
  await store.updateModel(model.id, {params: {c: '0'}});
  assert.equal((await store.getModel(model.id))?.params.contextSize, undefined);

  // Every spelling of the option is the same key.
  await store.updateModel(model.id, {params: {'ctx-size': '4096'}});
  assert.equal((await store.getModel(model.id))?.params.contextSize, 4096);
  await store.updateModel(model.id, {params: {LLAMA_ARG_CTX_SIZE: '2048'}});
  assert.equal((await store.getModel(model.id))?.params.contextSize, 2048);
});

test('Nelle writes a floor for llama.cpp auto-fit, never a context size', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});

  const preset = await fs.readFile(paths.llamaPresetPath, 'utf8');
  assert.doesNotMatch(preset, /^\s*c\s*=/m, 'llama.cpp picks the window; Nelle does not');
  assert.doesNotMatch(preset, /ctx-size/);

  // `--fit` is on by default and would otherwise settle on llama.cpp's own floor
  // of 4,096, in which Pi's system prompt does not fit. Measured against the real
  // binary: gemma-4-26B came up at 4,096 with nothing set, at 16,384 with a
  // 16,384 floor -- where it clamped every reply to one token, because its
  // empty-conversation prompt is 13,458 tokens and Pi reserves 4,096 more -- and
  // at 32,768 with this one, where it answers.
  assert.match(preset, new RegExp(`^fitc = ${PI_MINIMUM_CONTEXT_TOKENS}$`, 'm'));
  assert.deepEqual((await store.getState()).globalModelParams, {
    fitc: String(PI_MINIMUM_CONTEXT_TOKENS),
  });
  // The floor has to clear the arithmetic that makes a turn possible at all.
  assert.ok(
    PI_MINIMUM_CONTEXT_TOKENS >= minimumUsableContextSize(MEASURED_AGENT_PROMPT_TOKENS),
    "a floor below the measured prompt plus Pi's reserve clamps every reply to one token",
  );

  // A floor is not a cap: it must not become the model's context window.
  assert.equal((await store.getModel(model.id))?.params.contextSize, undefined);
  assert.equal(effectiveContextWindow((await store.getModel(model.id))!), null);
});

test('an empty params object clears every global param; an absent one does not', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const patch = async (payload: unknown) =>
      app.inject({method: 'PATCH', url: '/api/models/global-params', payload});

    // Read it back off `GET /api/models`, the catalog route -- not the retired `/api/state`,
    // which echoed the server's whole internal `AppState` and went with `apps/web`.
    await patch({params: {c: '16384', temp: '0.7'}});
    assert.deepEqual(
      (await app.inject({method: 'GET', url: '/api/models'})).json<{
        globalModelParams: Record<string, string>;
      }>().globalModelParams,
      {c: '16384', temp: '0.7'},
    );

    // A full replacement: `temp` is gone because the payload omitted it.
    const narrowed = await patch({params: {c: '16384'}});
    assert.deepEqual(narrowed.json<{globalModelParams: unknown}>().globalModelParams, {c: '16384'});

    // The whole point: the cap is removable. `{}` means "the user removed
    // everything", and used to answer `{"c":"16384"}`.
    // NOTE: this is the API *payload* (a flat `Record<string, string>`), not the `ModelParams`
    // type. `{}` here means "the user removed every global param" -- it must stay `{}`.
    const cleared = await patch({params: {}});
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json<{globalModelParams: unknown}>().globalModelParams, {});

    const preset = parseModelsIni(await fs.readFile(paths.llamaPresetPath, 'utf8'));
    assert.equal(getModelsIniSectionValues(preset, '*').size, 0);

    // An absent `params` key is a different thing, and zod refuses it outright.
    assert.equal((await patch({})).statusCode, 400);
  } finally {
    await app.close();
  }
});

test('a snapshot without a known window carries usage but no total', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const {ConversationRepository} = await import('../../apps/server/src/conversations.ts');
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Chat'});
    repository.replaceConversationProjection(conversation.id, {
      piSessionPath: '/tmp/session.jsonl',
      piSessionId: 'session-1',
      status: 'ready',
      entries: [
        {
          piEntryId: 'assistant-1',
          entryType: 'message',
          role: 'assistant',
          text: 'Hi',
          createdAt: '2026-07-08T12:00:01.000Z',
          performance: {
            source: 'llamacpp-timings',
            prompt: {tokens: 100, totalTokens: 100},
            generation: {tokens: 5},
          },
        },
      ],
    });

    const unknown = repository.getSnapshot(conversation.id, await store.getState());
    assert.equal(unknown?.context.usedTokens, 105);
    assert.equal(unknown?.context.totalTokens, undefined, 'no total, rather than a guessed one');
    // `contextUsageStatus` answers `ok` with no total, so the bar stays plain.
    assert.equal(unknown?.context.status, 'ok');

    // Once llama.cpp has reported a window, the same snapshot has a total.
    new ModelCacheRepository(database).upsertModelProps(model.id, {
      modelId: model.id,
      modalities: {vision: false, audio: false, video: false},
      contextWindow: 262_144,
      canReason: null,
      raw: {},
    });
    const known = repository.getSnapshot(conversation.id, await store.getState());
    assert.equal(known?.context.totalTokens, 262_144);
  } finally {
    database.close();
  }
});

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    modelsDir: path.join(dataDir, 'models'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    uploadsDir: path.join(dataDir, 'uploads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
  };
}
