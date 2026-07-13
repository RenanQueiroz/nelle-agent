import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {LlamaCppManager} from '../../apps/server/src/llamacpp.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import {SettingsRepository} from '../../apps/server/src/settings.ts';
import {SETTINGS_REGISTRY} from '../../packages/shared/src/settings.ts';
import {RUNTIME_SETTINGS_SLUG} from '../../packages/shared/src/settingsKeys.ts';

test('new Hugging Face imports use stable canonical section ids', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);

  const model = await store.addHuggingFaceModel({
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
  });

  assert.equal(model.id, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL');
  assert.equal(model.presetName, model.id);
  const preset = await fs.readFile(paths.llamaPresetPath, 'utf8');
  assert.match(preset, /\[unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:Q4_K_XL\]/);
  assert.match(preset, /hf-repo = unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/);
});

test('models.ini is the model catalog source of truth over stale state', async () => {
  const paths = await createTempPaths();
  await fs.mkdir(path.dirname(paths.statePath), {recursive: true});
  await fs.mkdir(path.dirname(paths.llamaPresetPath), {recursive: true});
  await fs.writeFile(
    paths.statePath,
    `${JSON.stringify(
      {
        version: 1,
        activeModelId: 'stale/model:Q4_K_M',
        models: [
          {
            id: 'stale/model:Q4_K_M',
            name: 'Stale model',
            presetName: 'stale/model:Q4_K_M',
            source: 'huggingface',
            repoId: 'stale/model',
            quant: 'UD-Q4_K_M',
            hfRef: 'stale/model:UD-Q4_K_M',
            params: {contextSize: 8192, extra: {'ctx-size': '8192'}},
            createdAt: '2026-07-08T12:00:00.000Z',
          },
        ],
        globalModelParams: {c: '8192'},
        runtime: {host: '127.0.0.1', port: 8080, modelsMax: 1, sleepIdleSeconds: 90},
        chat: [],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    paths.llamaPresetPath,
    [
      'version = 1',
      '',
      '[*]',
      'c = 16384',
      'threads = 8',
      '',
      '[repo/model:Q4_K_M]',
      'hf-repo = repo/model:UD-Q4_K_M',
      'alias = Fresh model',
      'ctx-size = 32768',
      'ubatch-size = 256',
      '',
    ].join('\n'),
  );

  const state = await new AppStore(paths).getState();

  assert.equal(state.activeModelId, 'repo/model:Q4_K_M');
  assert.deepEqual(state.globalModelParams, {c: '16384', threads: '8'});
  assert.equal(state.models.length, 1);
  assert.equal(state.models[0]?.id, 'repo/model:Q4_K_M');
  assert.equal(state.models[0]?.name, 'Fresh model');
  assert.equal(state.models[0]?.hfRef, 'repo/model:UD-Q4_K_M');
  assert.equal(state.models[0]?.params.contextSize, 32768);
  assert.deepEqual(state.models[0]?.params.extra, {
    'ctx-size': '32768',
    'ubatch-size': '256',
  });
});

test('model param saves replace editable models.ini params', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });

  await store.updateModel(model.id, {
    params: {'custom-flag': 'keep-me', 'ctx-size': '32768', 'ubatch-size': '256'},
  });
  await store.updateModel(model.id, {params: {'ctx-size': '4096'}});

  const written = await fs.readFile(paths.llamaPresetPath, 'utf8');
  assert.match(written, /ctx-size = 4096/);
  assert.doesNotMatch(written, /ubatch-size/);
});

test('writePreset uses lossless models.ini updates for managed keys', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await fs.mkdir(path.dirname(paths.llamaPresetPath), {recursive: true});
  await fs.writeFile(
    paths.llamaPresetPath,
    [
      '# keep this comment',
      'version = 1',
      '',
      '[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]',
      'custom-flag = keep-me',
      'load-on-startup = true',
      '',
    ].join('\n'),
  );

  const model = await store.addHuggingFaceModel({
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    name: 'Qwen 35B Q4 XL',
  });
  await store.updateGlobalModelParams({c: '16384', threads: '8'});
  await store.updateModel(model.id, {
    params: {'custom-flag': 'keep-me', 'ctx-size': '32768', 'ubatch-size': '256'},
  });
  const llama = new LlamaCppManager(paths, store);
  await llama.writePreset(model);

  const written = await fs.readFile(paths.llamaPresetPath, 'utf8');
  const backup = await fs.readFile(`${paths.llamaPresetPath}.bak`, 'utf8');

  assert.match(written, /# keep this comment/);
  assert.match(written, /custom-flag = keep-me/);
  assert.match(written, /\[\*\]\n(?:.*\n)*c = 16384/);
  assert.match(written, /threads = 8/);
  assert.match(written, /hf-repo = unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/);
  assert.match(written, /alias = Qwen 35B Q4 XL/);
  assert.match(written, /ctx-size = 32768/);
  assert.match(written, /ubatch-size = 256/);
  assert.doesNotMatch(written, /load-on-startup/);
  assert.match(backup, /version = 1/);
});

test('removeModelSection deletes removed model from models.ini', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const llama = new LlamaCppManager(paths, store);
  await llama.writePreset();
  await store.removeModel(model.id);
  await llama.removeModelSection(model.id);
  await llama.writePreset();

  const written = await fs.readFile(paths.llamaPresetPath, 'utf8');
  assert.doesNotMatch(written, /\[repo\/model:Q4_K_M\]/);
});

test('start launches router mode with zero configured models', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const port = await getFreePort();
  await store.updateRuntimeSettings({port});
  // The launch limits are a settings group now, not a corner of `state.json`. This is the
  // test that proves the group actually reaches llama.cpp's command line.
  const database = new AppDatabase(paths);
  await database.open();
  const settings = new SettingsRepository(database, SETTINGS_REGISTRY);
  settings.updateGroup(RUNTIME_SETTINGS_SLUG, {modelsMax: 3, sleepIdleSeconds: 45});
  const fakeServerPath = path.join(paths.dataDir, 'fake-llama-server.cjs');
  const argsPath = path.join(paths.dataDir, 'fake-llama-args.json');
  await fs.writeFile(fakeServerPath, fakeLlamaServerScript(), {mode: 0o755});
  await fs.chmod(fakeServerPath, 0o755);
  const previousServerPath = process.env.LLAMA_SERVER_PATH;
  const previousArgsPath = process.env.NELLE_FAKE_LLAMA_ARGS;
  process.env.LLAMA_SERVER_PATH = fakeServerPath;
  process.env.NELLE_FAKE_LLAMA_ARGS = argsPath;
  const llama = new LlamaCppManager(paths, store, settings);

  try {
    const status = await llama.start();
    const args = JSON.parse(await fs.readFile(argsPath, 'utf8')) as string[];
    const preset = await fs.readFile(paths.llamaPresetPath, 'utf8');

    assert.equal(status.running, true);
    assert.ok(status.pid);
    assert.deepEqual(args.slice(0, 8), [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--models-preset',
      paths.llamaPresetPath,
      '--models-max',
      '3',
    ]);
    assert.deepEqual(args.slice(8), ['--sleep-idle-seconds', '45']);
    assert.equal(args.includes('--model'), false);
    assert.match(preset, /version = 1/);
  } finally {
    await llama.stop().catch(() => undefined);
    database.close();
    if (previousServerPath == null) {
      delete process.env.LLAMA_SERVER_PATH;
    } else {
      process.env.LLAMA_SERVER_PATH = previousServerPath;
    }
    if (previousArgsPath == null) {
      delete process.env.NELLE_FAKE_LLAMA_ARGS;
    } else {
      process.env.NELLE_FAKE_LLAMA_ARGS = previousArgsPath;
    }
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
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }
        if (typeof address === 'object' && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error('Could not allocate a free test port.'));
      });
    });
  });
}

function fakeLlamaServerScript(): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.NELLE_FAKE_LLAMA_ARGS, JSON.stringify(args));
const valueAfter = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const host = valueAfter('--host') || '127.0.0.1';
const port = Number(valueAfter('--port') || 8080);
const server = http.createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({data: []}));
    return;
  }
  response.writeHead(404);
  response.end();
});
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(port, host);
`;
}
