import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'bun:test';

import {LlamaCppManager} from '../../../apps/server/src/llama/manager.ts';
import {AppStore} from '../../../apps/server/src/models/store.ts';
import {
  getModelsIniSectionValues,
  parseModelsIni,
} from '../../../apps/server/src/contracts/modelsIni.ts';
import {createTestServer} from '../helpers/testServer.ts';
import {createTempPaths} from '../helpers/paths.ts';

/**
 * A downloaded model must not be breakable by a stranger editing a repository.
 *
 * llama.cpp re-resolves `hf-repo` against Hugging Face on **every** load, and its cache
 * fallback fires only when the repo listing comes back *empty*. So a deleted, gated or
 * unreachable repo is survivable -- but one that still exists and has merely **dropped your
 * quant** (a re-upload, a rename, a prune) is not: the listing succeeds, the tag is not in
 * it, and llama-server exits with `failed to load model ''` while the weights sit intact on
 * disk. Reproduced against a real load, with a fake Hugging Face serving a healthy repo that
 * no longer offered the quant.
 *
 * `offline = 1` stops the re-resolution, and a successful load is proof the blobs are
 * complete -- so Nelle pins there. It cannot be the default: `offline` also means "never
 * download", so a fresh import would have nothing to fetch with.
 */

async function preset(path: string, sectionId: string): Promise<Map<string, string>> {
  return getModelsIniSectionValues(parseModelsIni(await fs.readFile(path, 'utf8')), sectionId);
}

test('a fresh import is NOT pinned, or it could never download its weights', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  await new LlamaCppManager(paths, store).writePreset();

  assert.equal(model.pinned, false);
  // `offline = 1` means "never reach Hugging Face" -- with nothing cached, llama.cpp's
  // download plan would come back empty and the model could never be fetched at all.
  assert.equal((await preset(paths.llamaPresetPath, model.id)).get('offline'), undefined);
});

test('the pin reaches models.ini, and survives a preset rewrite', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const llama = new LlamaCppManager(paths, store);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});

  await store.updateModel(model.id, {pinned: true});
  await llama.writePreset();
  assert.equal((await preset(paths.llamaPresetPath, model.id)).get('offline'), '1');

  // `llamacpp.ts` used to carry its own copy of `modelSourceValues`, and `writePreset` used
  // *that* one -- so a field added to the store's copy was written to state and then
  // silently stripped from the preset on the very next write. An unrelated edit is exactly
  // when that would have bitten.
  await store.updateModel(model.id, {params: {temp: '0.7'}});
  await llama.writePreset();
  const after = await preset(paths.llamaPresetPath, model.id);
  assert.equal(after.get('offline'), '1', 'the pin survived a params save');
  assert.equal(after.get('temp'), '0.7');
});

test('un-pinning lets the next load re-check Hugging Face', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const llama = new LlamaCppManager(paths, store);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});

  await store.updateModel(model.id, {pinned: true});
  await llama.writePreset();
  await store.updateModel(model.id, {pinned: false});
  await llama.writePreset();

  assert.equal((await preset(paths.llamaPresetPath, model.id)).get('offline'), undefined);
  assert.equal((await store.getModel(model.id))?.pinned, false);
});

test('the pin is a field, not a parameter -- it never appears in the editor', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  await store.updateModel(model.id, {pinned: true});

  const pinned = await store.getModel(model.id);
  assert.equal(pinned?.pinned, true);
  // Nelle writes `offline` after a successful load. If it were an editable param, a user who
  // deleted the row would watch it come straight back -- the same fight `stop-timeout` used
  // to pick, and the reason that key no longer exists.
  assert.deepEqual(pinned?.params.extra, {});

  const app = await createTestServer(paths);
  try {
    const refused = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {params: {offline: '0'}},
    });
    assert.equal(refused.statusCode, 400);
    const body = refused.json<{
      error: {code: string};
      invalidParams: Array<{key: string; reason: string}>;
    }>();
    assert.equal(body.error.code, 'reserved_model_param');
    assert.deepEqual(body.invalidParams[0], {
      key: 'offline',
      reason: 'reserved',
      message: 'Set "offline" through the dedicated model field instead of params.',
    });
  } finally {
    await app.close();
  }
});

test('PATCH /api/models/:id pins and un-pins through the contract', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'repo/model', quant: 'UD-Q4_K_M'});
  const app = await createTestServer(paths);

  try {
    const unpin = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {pinned: true},
    });
    assert.equal(unpin.statusCode, 200);
    assert.equal(unpin.json<{model: {pinned: boolean}}>().model.pinned, true);
    assert.equal((await preset(paths.llamaPresetPath, model.id)).get('offline'), '1');

    // Un-pinning is how an upstream fix (a corrected chat template, a re-quant) lands: the
    // next load re-resolves, and re-pins itself once it succeeds.
    const repin = await app.inject({
      method: 'PATCH',
      url: `/api/models/${encodeURIComponent(model.id)}`,
      payload: {pinned: false},
    });
    assert.equal(repin.json<{model: {pinned: boolean}}>().model.pinned, false);
    assert.equal((await preset(paths.llamaPresetPath, model.id)).get('offline'), undefined);
  } finally {
    await app.close();
  }
});
