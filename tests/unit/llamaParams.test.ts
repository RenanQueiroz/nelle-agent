import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test, afterEach} from 'bun:test';

import {LlamaOptionCatalogueCache} from '../../apps/server/src/llamaParams.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createTestServer} from './helpers/testServer.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {getModelsIniSectionValues, parseModelsIni} from '../../packages/shared/src/modelsIni.ts';

const FIXTURE_HELP = path.resolve('tests/fixtures/llama-server-help.txt');
const originalServerPath = process.env.LLAMA_SERVER_PATH;

afterEach(() => {
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
  }
});

/** A stand-in for `llama-server` that prints whatever help text it is given. */
async function fakeBinary(directory: string, body: string): Promise<string> {
  const file = path.join(directory, 'llama-server');
  await fs.writeFile(file, body, {mode: 0o755});
  return file;
}

async function helpPrinter(directory: string, helpTextPath: string): Promise<string> {
  return fakeBinary(directory, `#!/bin/sh\ncat ${JSON.stringify(helpTextPath)}\n`);
}

test('the catalogue is read from the binary and cached against it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  const binary = await helpPrinter(directory, FIXTURE_HELP);
  let calls = 0;
  const cache = new LlamaOptionCatalogueCache(async () => {
    calls += 1;
    return binary;
  });

  const first = await cache.get();
  assert.equal(first.available, true);
  assert.equal(first.options.length, 244);

  // A second read does not re-run the binary's `--help`, but it does re-stat it.
  const second = await cache.get();
  assert.equal(second, first, 'the same object, so nothing re-parsed');
  assert.equal(calls, 2);
});

test('a rebuilt binary at the same path is parsed again', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  const binary = await helpPrinter(directory, FIXTURE_HELP);
  const cache = new LlamaOptionCatalogueCache(async () => binary);
  assert.equal((await cache.get()).options.length, 244);

  // A different llama.cpp, same path. Size changes, so the signature does.
  const trimmed = path.join(directory, 'trimmed-help.txt');
  await fs.writeFile(
    trimmed,
    '----- common params -----\n-c,    --ctx-size N   size of the prompt context\n',
  );
  await fs.writeFile(binary, `#!/bin/sh\ncat ${JSON.stringify(trimmed)}\n`, {mode: 0o755});

  const second = await cache.get();
  assert.equal(second.available, true);
  // One parsed option, plus the two preset-only keys `--help` cannot print.
  assert.equal(second.options.length, 3);
  assert.equal(await cache.acceptedKeys().then(keys => keys?.has('temp')), false);
});

test('no binary, or one that will not run, means no unknown-key check', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));

  const absent = new LlamaOptionCatalogueCache(async () => path.join(directory, 'nothing-here'));
  assert.deepEqual(await absent.get(), {available: false, options: []});
  assert.equal(await absent.acceptedKeys(), undefined);

  const unresolved = new LlamaOptionCatalogueCache(async () => null);
  assert.equal((await unresolved.get()).available, false);

  // Installed, but `--help` exits non-zero: an external binary Nelle did not build.
  const broken = await fakeBinary(directory, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
  const failing = new LlamaOptionCatalogueCache(async () => broken);
  assert.equal((await failing.get()).available, false);

  // Runs, but prints something Nelle cannot parse. An empty accept-set would
  // reject every key, so this is unavailable too.
  const silent = await fakeBinary(directory, '#!/bin/sh\necho "usage: llama-server"\n');
  const unparsed = new LlamaOptionCatalogueCache(async () => silent);
  assert.equal((await unparsed.get()).available, false);
});

test('GET /api/llama/params serves the catalogue', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  process.env.LLAMA_SERVER_PATH = await helpPrinter(directory, FIXTURE_HELP);
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({method: 'GET', url: '/api/llama/params'});
    assert.equal(response.statusCode, 200);
    const body = response.json<{available: boolean; options: Array<{keys: string[]}>}>();
    assert.equal(body.available, true);
    const ctxSize = body.options.find(option => option.keys.includes('c'));
    assert.deepEqual(ctxSize?.keys, ['c', 'ctx-size']);
  } finally {
    await app.close();
  }
});

test('a global param typo is refused, named, and never reaches models.ini', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  process.env.LLAMA_SERVER_PATH = await helpPrinter(directory, FIXTURE_HELP);
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {temprature: '0.7', 'tpo-k': '40', c: '16384'}},
    });
    assert.equal(response.statusCode, 400);
    const body = response.json<{
      error: {code: string; message: string};
      invalidParams: Array<{key: string; reason: string; suggestion?: string}>;
    }>();
    assert.equal(body.error.code, 'invalid_model_param');
    assert.match(body.error.message, /2 parameters are not valid/);
    // Both typos, on one save. A form with three should light up three rows.
    assert.deepEqual(
      body.invalidParams.map(entry => [entry.key, entry.reason, entry.suggestion]),
      [
        ['temprature', 'unknown', 'temperature'],
        ['tpo-k', 'unknown', 'top-k'],
      ],
    );

    // Nothing was written: llama-server would have refused to start.
    const preset = await fs.readFile(paths.llamaPresetPath, 'utf8').catch(() => '');
    assert.doesNotMatch(preset, /temprature/);
  } finally {
    await app.close();
  }
});

test('a reserved key keeps its own code, and a good save still lands', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  process.env.LLAMA_SERVER_PATH = await helpPrinter(directory, FIXTURE_HELP);
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  const app = await createTestServer(paths);
  try {
    const reserved = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {params: {alias: 'mine'}},
    });
    assert.equal(reserved.statusCode, 400);
    assert.equal(reserved.json<{error: {code: string}}>().error.code, 'reserved_model_param');
    assert.equal(
      reserved.json<{invalidParams: Array<{reason: string}>}>().invalidParams[0]?.reason,
      'reserved',
    );

    // A real sampling key saves, and reaches the preset. So does `stop-timeout`, which
    // `--help` never prints -- it is `set_preset_only()`, so only `PRESET_ONLY_KEYS` keeps
    // the validator from calling a key llama-server accepts a typo. The *user* submits it
    // here: Nelle writes no defaults of its own into a section.
    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {params: {temp: '0.7', 'top-k': '40', 'stop-timeout': '30'}},
    });
    assert.equal(saved.statusCode, 200);
    const document = parseModelsIni(await fs.readFile(paths.llamaPresetPath, 'utf8'));
    const values = getModelsIniSectionValues(document, model.id);
    assert.equal(values.get('temp'), '0.7');
    assert.equal(values.get('top-k'), '40');
    assert.equal(values.get('stop-timeout'), '30');
  } finally {
    await app.close();
  }
});

test('without a binary, an unknown key is saved rather than refused', async () => {
  // Refusing to save a parameter because Nelle could not run a binary would be
  // worse than the typo.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-bin-'));
  process.env.LLAMA_SERVER_PATH = path.join(directory, 'absent');
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {temprature: '0.7'}},
    });
    assert.equal(response.statusCode, 200);
    // A full replacement of `[*]`, and no invented `c` riding along.
    assert.deepEqual(
      response.json<{globalModelParams: Record<string, string>}>().globalModelParams,
      {temprature: '0.7'},
    );

    // The catalogue route says so plainly, rather than serving an empty list as
    // though llama.cpp had no options.
    assert.deepEqual((await app.inject({method: 'GET', url: '/api/llama/params'})).json(), {
      available: false,
      options: [],
    });
  } finally {
    await app.close();
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
