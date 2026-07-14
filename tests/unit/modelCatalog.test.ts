import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import type {AppPaths} from '../../apps/server/src/lib/paths.ts';
import type {ModelCatalogContract} from '../../apps/server/src/contracts/modelCatalog.ts';
import {createTestServer, type TestServer} from './helpers/testServer.ts';

/**
 * Every catalog mutation answers with the whole catalog, because every one of them can
 * move more than the row it touched: a duplicate becomes the active model, deleting the
 * active model promotes a neighbour, and editing `[*]` changes the predicted context size
 * of every model at once. A client applies what the server answers with rather than
 * patching one row and guessing at the rest.
 *
 * They used to answer with the server's entire `AppState` -- the legacy 100-message
 * `chat[]` and llama.cpp's host and port included -- which no client ever read.
 */

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-catalog-'));
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

/** Imports a model. No network: this only writes a `models.ini` section. */
async function importModel(app: TestServer, repoId: string, quant: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/huggingface/use',
    payload: {repoId, quant},
  });
  assert.equal(response.statusCode, 200);
  return response.json<{model: {id: string}}>().model.id;
}

test('a catalog mutation answers with the catalog, and never with the whole AppState', async () => {
  const app = await createTestServer(await createTempPaths());
  try {
    const first = await importModel(app, 'unsloth/gemma-4-E4B-it-qat-GGUF', 'Q4_K_XL');
    const second = await importModel(app, 'unsloth/gemma-4-E2B-it-qat-GGUF', 'Q4_K_XL');

    const activate = await app.inject({
      method: 'POST',
      url: `/api/models/${encodeURIComponent(first)}/activate`,
      payload: {},
    });
    assert.equal(activate.statusCode, 200);
    const body = activate.json<{
      model: {id: string};
      catalog: ModelCatalogContract;
      state?: unknown;
    }>();

    assert.equal(body.model.id, first);
    assert.equal(body.catalog.activeModelId, first);
    assert.deepEqual(body.catalog.models.map(model => model.id).sort(), [second, first].sort());

    // The legacy `chat[]` rode along inside `state` on every one of these responses.
    assert.equal(body.state, undefined, 'AppState must not be echoed back to a client');
  } finally {
    await app.close();
  }
});

test('duplicating activates the copy, and the catalog says so without a refetch', async () => {
  const app = await createTestServer(await createTempPaths());
  try {
    const original = await importModel(app, 'unsloth/gemma-4-E4B-it-qat-GGUF', 'Q4_K_XL');

    const response = await app.inject({
      method: 'POST',
      url: `/api/models/${encodeURIComponent(original)}/duplicate`,
      payload: {},
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{model: {id: string}; catalog: ModelCatalogContract}>();

    // The server activates the copy. A client that only read `{model}` had to refetch to
    // discover that the *selection* had moved -- which is what the browser does today.
    assert.notEqual(body.model.id, original);
    assert.equal(body.catalog.activeModelId, body.model.id);
    assert.equal(body.catalog.models.length, 2);
  } finally {
    await app.close();
  }
});

test('deleting the active model promotes a neighbour, and the catalog carries it', async () => {
  const app = await createTestServer(await createTempPaths());
  try {
    const first = await importModel(app, 'unsloth/gemma-4-E4B-it-qat-GGUF', 'Q4_K_XL');
    const second = await importModel(app, 'unsloth/gemma-4-E2B-it-qat-GGUF', 'Q4_K_XL');
    await app.inject({
      method: 'POST',
      url: `/api/models/${encodeURIComponent(second)}/activate`,
      payload: {},
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(second)}`,
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      ok: boolean;
      removedModelId: string;
      catalog: ModelCatalogContract;
      state?: unknown;
    }>();

    assert.equal(body.removedModelId, second);
    assert.deepEqual(
      body.catalog.models.map(model => model.id),
      [first],
    );
    assert.equal(
      body.catalog.activeModelId,
      first,
      'the selection moved, and the catalog says where',
    );
    assert.equal(body.state, undefined);
  } finally {
    await app.close();
  }
});

test('editing [*] changes the predicted context size of every model at once', async () => {
  // This is the whole argument for answering with the catalog. `c` in `[*]` cascades into
  // every section that does not override it, so a one-key edit rewrites a derived field on
  // every row -- and a client that patched only the row it touched would show stale numbers
  // on all the others.
  const app = await createTestServer(await createTempPaths());
  try {
    await importModel(app, 'unsloth/gemma-4-E4B-it-qat-GGUF', 'Q4_K_XL');
    await importModel(app, 'unsloth/gemma-4-E2B-it-qat-GGUF', 'Q4_K_XL');

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {c: '8192'}},
    });
    assert.equal(response.statusCode, 200);
    const body = response.json<{
      globalModelParams: Record<string, string>;
      catalog: ModelCatalogContract;
    }>();

    assert.deepEqual(body.globalModelParams, {c: '8192'});
    assert.deepEqual(
      body.catalog.models.map(model => model.params.contextSize),
      [8192, 8192],
    );

    // ...and taking the cap away puts them back to "no cap", which is what a full
    // replacement is for: an empty payload clears the section.
    const cleared = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {}},
    });
    const after = cleared.json<{catalog: ModelCatalogContract}>();
    assert.deepEqual(
      after.catalog.models.map(model => model.params.contextSize),
      [undefined, undefined],
      'absent is "no cap", and it is the normal case',
    );
  } finally {
    await app.close();
  }
});

test('a model carries only the params the server actually sends', async () => {
  const app = await createTestServer(await createTempPaths());
  try {
    const id = await importModel(app, 'unsloth/gemma-4-E4B-it-qat-GGUF', 'Q4_K_XL');

    // A freshly imported model has **no params at all**, and that is the honest answer: it
    // is running on llama.cpp's defaults. Nelle used to stamp `stop-timeout = 10` into
    // every section -- which is llama.cpp's own default -- so a brand-new model opened its
    // editor showing one row nobody had asked for and nobody could delete.
    const fresh = await app.inject({method: 'GET', url: '/api/models'});
    assert.deepEqual(
      fresh.json<{models: Array<{params: {extra: unknown}}>}>().models[0]?.params.extra,
      {},
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(id)}`,
      payload: {params: {temp: '0.7'}},
    });
    assert.equal(response.statusCode, 200);
    const model = response.json<{model: {params: Record<string, unknown>}}>().model;

    // `gpuLayers`, `threads` and `batchSize` were in the contract and were never once
    // populated -- the read path builds params from `extra` alone. A promised field the
    // server never sends is worse than a missing one: a client renders a control for it.
    assert.deepEqual(Object.keys(model.params).sort(), ['extra']);

    // A full replacement means exactly what it says: what the user sent, and nothing else.
    assert.deepEqual(model.params.extra, {temp: '0.7'});
  } finally {
    await app.close();
  }
});
