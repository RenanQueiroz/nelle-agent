import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {LlamaCppManager} from '../../apps/server/src/llamacpp.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createServer} from '../../apps/server/src/server.ts';
import {AppStore} from '../../apps/server/src/store.ts';

process.env.LOG_LEVEL = 'silent';

test('llama router facade normalizes props, models, model props, actions, and events', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset(model);
  const app = await createServer(paths);

  try {
    const propsResponse = await app.inject({method: 'GET', url: '/api/llama/props'});
    assert.equal(propsResponse.statusCode, 200);
    const props = propsResponse.json<{
      role: string;
      maxInstances: number;
      modelsAutoload: boolean;
    }>();
    assert.equal(props.role, 'router');
    assert.equal(props.maxInstances, 1);
    assert.equal(props.modelsAutoload, false);

    const modelsResponse = await app.inject({method: 'GET', url: '/api/llama/models'});
    assert.equal(modelsResponse.statusCode, 200);
    const models = modelsResponse.json<{
      models: Array<{sectionId: string; alias: string; hfRepo: string; status: string}>;
    }>().models;
    assert.equal(models[0]?.sectionId, 'repo/model:Q4_K_M');
    assert.equal(models[0]?.alias, 'Model Q4');
    assert.equal(models[0]?.hfRepo, 'repo/model:UD-Q4_K_M');
    assert.equal(models[0]?.status, 'loaded');

    const modelPropsResponse = await app.inject({
      method: 'GET',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/props`,
    });
    assert.equal(modelPropsResponse.statusCode, 200);
    const modelProps = modelPropsResponse.json<{
      modelId: string;
      contextWindow: number;
      modalities: {vision: boolean; audio: boolean; video: boolean};
    }>();
    assert.equal(modelProps.modelId, model.id);
    assert.equal(modelProps.contextWindow, 32768);
    assert.deepEqual(modelProps.modalities, {vision: true, audio: false, video: false});

    const tokenizeResponse = await app.inject({
      method: 'POST',
      url: '/api/llama/tokenize',
      payload: {content: 'hello local model'},
    });
    assert.equal(tokenizeResponse.statusCode, 200);
    assert.deepEqual(tokenizeResponse.json<{tokens: number}>(), {
      tokens: 3,
      raw: {tokens: [1, 2, 3]},
    });

    const loadResponse = await app.inject({
      method: 'POST',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/load`,
    });
    assert.equal(loadResponse.statusCode, 200);
    assert.equal(loadResponse.json<{modelId: string}>().modelId, model.id);

    const unloadResponse = await app.inject({
      method: 'POST',
      url: `/api/llama/models/${encodeURIComponent(model.id)}/unload`,
    });
    assert.equal(unloadResponse.statusCode, 200);
    assert.equal(unloadResponse.json<{modelId: string}>().modelId, model.id);

    const reloadResponse = await app.inject({
      method: 'POST',
      url: '/api/llama/models/reload',
    });
    assert.equal(reloadResponse.statusCode, 200);
    assert.ok(router.calls.some(call => call.url === '/models?reload=1'));

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/llama/models/events',
    });
    assert.equal(eventsResponse.statusCode, 200);
    assert.match(eventsResponse.body, /event: model_status/);

    const actionBodies = router.calls
      .filter(call => call.url === '/models/load' || call.url === '/models/unload')
      .map(call => call.body);
    assert.deepEqual(actionBodies, [{model: model.id}, {model: model.id}]);
  } finally {
    await app.close();
    await router.close();
  }
});

test('llama abort verifier warns when slots keep processing after grace window', async () => {
  const processingSlot = {
    id: 2,
    id_task: 91,
    is_processing: true,
    next_token: [{has_next_token: true, n_decoded: 128}],
  };
  const router = await createMockRouter({slots: [[processingSlot], []]});
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const llama = new LlamaCppManager(paths, store);

  try {
    const stuck = await llama.verifyAbortIdle({
      modelId: 'repo/model:Q4_K_M',
      graceMs: 0,
      pollMs: 50,
    });
    assert.equal(stuck.checked, true);
    assert.equal(stuck.idle, false);
    assert.equal(stuck.warning?.code, 'llama_slot_still_processing');
    assert.match(stuck.warning?.detail ?? '', /slot 2 task 91/);

    const idle = await llama.verifyAbortIdle({
      modelId: 'repo/model:Q4_K_M',
      graceMs: 0,
      pollMs: 50,
    });
    assert.equal(idle.checked, true);
    assert.equal(idle.idle, true);
    assert.equal(idle.warning, undefined);
  } finally {
    await router.close();
  }
});

test('llama router facade returns stable 502 errors for upstream failures', async () => {
  const router = await createMockRouter({failModels: true});
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const app = await createServer(paths);

  try {
    const response = await app.inject({method: 'GET', url: '/api/llama/models'});
    assert.equal(response.statusCode, 502);
    assert.equal(
      response.json<{error: {code: string}}>().error.code,
      'llama_router_request_failed',
    );
  } finally {
    await app.close();
    await router.close();
  }
});

test('model settings endpoints edit params, duplicate, and remove sections', async () => {
  const router = await createMockRouter();
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.updateRuntimeSettings({port: router.port});
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  await new LlamaCppManager(paths, store).writePreset();
  const app = await createServer(paths);

  try {
    const globalResponse = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {c: '16384', threads: '6'}},
    });
    assert.equal(globalResponse.statusCode, 200);
    assert.deepEqual(globalResponse.json().globalModelParams, {c: '16384', threads: '6'});

    const invalidResponse = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {params: {'hf-repo': 'other/model:Q4_K_M'}},
    });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(
      invalidResponse.json<{error: {code: string}}>().error.code,
      'reserved_model_param',
    );

    const editResponse = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {name: 'Edited alias', params: {'ctx-size': '32768'}},
    });
    assert.equal(editResponse.statusCode, 200);
    assert.equal(editResponse.json<{model: {name: string}}>().model.name, 'Edited alias');

    const duplicateResponse = await app.inject({
      method: 'POST',
      url: `/api/models/${encodeURIComponent(model.id)}/duplicate`,
    });
    assert.equal(duplicateResponse.statusCode, 200);
    const duplicateId = duplicateResponse.json<{model: {id: string}}>().model.id;
    assert.match(duplicateId, /copy/);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(model.id)}`,
    });
    assert.equal(deleteResponse.statusCode, 200);

    const preset = await fs.readFile(paths.llamaPresetPath, 'utf8');
    assert.match(preset, /\[\*\]/);
    assert.match(preset, /c = 16384/);
    assert.doesNotMatch(preset, /\[repo\/model:Q4_K_M\]/);
    assert.match(preset, new RegExp(`\\[${escapeRegExp(duplicateId)}\\]`));
    assert.ok(router.calls.some(call => call.url === '/models?reload=1'));
  } finally {
    await app.close();
    await router.close();
  }
});

async function createMockRouter(input: {failModels?: boolean; slots?: unknown[][]} = {}): Promise<{
  port: number;
  calls: Array<{method: string; url: string; body: unknown}>;
  close: () => Promise<void>;
}> {
  const calls: Array<{method: string; url: string; body: unknown}> = [];
  let slotCallCount = 0;
  const server = http.createServer(async (request, response) => {
    const url = request.url ?? '/';
    const body = await readJsonBody(request);
    calls.push({method: request.method ?? 'GET', url, body});

    if (url === '/v1/models') {
      sendJson(response, {data: []});
      return;
    }
    if (url === '/props') {
      sendJson(response, {role: 'router', max_instances: 1, models_autoload: false});
      return;
    }
    if (url.startsWith('/props?')) {
      sendJson(response, {
        modalities: {vision: true, audio: false, video: false},
        default_generation_settings: {n_ctx: 32768},
        chat_template: 'chatml',
      });
      return;
    }
    if (url === '/tokenize') {
      sendJson(response, {tokens: [1, 2, 3]});
      return;
    }
    if (url.startsWith('/slots')) {
      const slots =
        input.slots?.[Math.min(slotCallCount, Math.max(0, input.slots.length - 1))] ?? [];
      slotCallCount += 1;
      sendJson(response, slots);
      return;
    }
    if (url === '/models/sse') {
      response.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8'});
      response.end('event: model_status\ndata: {"id":"repo/model:Q4_K_M"}\n\n');
      return;
    }
    if (url === '/models/load' || url === '/models/unload') {
      sendJson(response, {ok: true});
      return;
    }
    if (url === '/models' || url === '/models?reload=1') {
      if (input.failModels) {
        response.writeHead(500, {'content-type': 'text/plain'});
        response.end('router failed');
        return;
      }
      sendJson(response, [
        {
          id: 'repo/model:Q4_K_M',
          aliases: ['repo/model:Q4_K_M'],
          source: 'repo/model:UD-Q4_K_M',
          status: {value: 'loaded'},
          can_remove: false,
          architecture: 'qwen3',
        },
      ]);
      return;
    }

    response.writeHead(404, {'content-type': 'text/plain'});
    response.end('not found');
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);

  return {
    port: address.port,
    calls,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of request) {
    text += String(chunk);
  }
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

function sendJson(response: http.ServerResponse, payload: unknown): void {
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(JSON.stringify(payload));
}

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    attachmentsDir: path.join(dataDir, 'attachments'),
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
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
