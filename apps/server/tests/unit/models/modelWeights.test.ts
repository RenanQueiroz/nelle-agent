import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'bun:test';

import {repoDiskBytes, repoFolderName} from '../../../src/llama/weights.ts';
import {AppStore} from '../../../src/models/store.ts';
import type {ConfiguredModel} from '../../../src/lib/types.ts';
import {createTestServer} from '../helpers/testServer.ts';
import {createTempPaths} from '../helpers/paths.ts';
import type {ModelCatalogContract} from '../../../src/contracts/modelCatalog.ts';

/**
 * Deleting a model has always left its weights on disk for ever, invisibly -- which is how a
 * 6.7 GB model nobody had configured came to be sitting in the cache. Reclaiming them is only
 * possible, and only *safe*, because Nelle owns the cache now: in the user's global
 * `~/.cache/huggingface/hub` those blobs are shared with every other Hugging Face tool.
 */

/** Writes a Hugging Face-layout repo: real blobs, and a snapshot of symlinks into them. */
async function fakeRepo(
  modelsDir: string,
  repoId: string,
  blobs: Record<string, number>,
): Promise<void> {
  const repo = path.join(modelsDir, repoFolderName(repoId));
  await fs.mkdir(path.join(repo, 'blobs'), {recursive: true});
  await fs.mkdir(path.join(repo, 'snapshots', 'abc123'), {recursive: true});
  for (const [name, size] of Object.entries(blobs)) {
    await fs.writeFile(path.join(repo, 'blobs', name), Buffer.alloc(size));
    await fs.symlink(
      path.join('..', '..', 'blobs', name),
      path.join(repo, 'snapshots', 'abc123', `${name}.gguf`),
    );
  }
}

test('a repo is measured once, not twice -- the snapshot is symlinks', async () => {
  const paths = await createTempPaths();
  await fakeRepo(paths.modelsDir, 'org/repo', {a: 1000, b: 2000});

  // Following the snapshot symlinks would count every byte a second time, and report a 15 GB
  // model as 30 GB.
  assert.equal(await repoDiskBytes(paths.modelsDir, 'org/repo'), 3000);
});

test('nothing downloaded is `null`, not zero', async () => {
  const paths = await createTempPaths();
  // Absent is a real state -- the weights arrive on the model's *first load* -- and it is not
  // the same as "an empty model".
  assert.equal(await repoDiskBytes(paths.modelsDir, 'org/never-fetched'), null);
});

test('the catalog reports what a model costs on disk', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q4_K_M'});
  await fakeRepo(paths.modelsDir, 'org/repo', {weights: 4096});

  const app = await createTestServer(paths);
  try {
    const catalog = (
      await app.inject({method: 'GET', url: '/api/models'})
    ).json<ModelCatalogContract>();
    assert.equal(catalog.models[0]?.diskBytes, 4096);
  } finally {
    await app.close();
  }
});

test('deleting with ?weights=1 reclaims the blobs', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q4_K_M'});
  await fakeRepo(paths.modelsDir, 'org/repo', {weights: 8192});

  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(model.id)}?weights=1`,
    });
    const body = response.json<{
      weightsRemoved: boolean;
      reclaimedBytes: number;
      sharedWithModelIds: string[];
    }>();

    assert.equal(body.weightsRemoved, true);
    assert.equal(body.reclaimedBytes, 8192);
    assert.deepEqual(body.sharedWithModelIds, []);
    assert.equal(await repoDiskBytes(paths.modelsDir, 'org/repo'), null, 'the blobs are gone');
  } finally {
    await app.close();
  }
});

test('deleting WITHOUT ?weights=1 leaves them alone', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q4_K_M'});
  await fakeRepo(paths.modelsDir, 'org/repo', {weights: 8192});

  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(model.id)}`,
    });
    assert.equal(response.json<{weightsRemoved: boolean}>().weightsRemoved, false);
    assert.equal(await repoDiskBytes(paths.modelsDir, 'org/repo'), 8192);
  } finally {
    await app.close();
  }
});

test('a sibling on the same repo keeps its weights, even when weights are asked for', async () => {
  // **The one that could destroy data.** A Hugging Face repo directory holds *every* quant of
  // that repo, so two models on one `repoId` share one pile of blobs. Deleting the directory
  // would silently take a working model's weights with it -- and this is not exotic:
  // duplicating a model produces exactly this, as does importing a second quant.
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const first = await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q4_K_M'});
  const second = await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q8_0'});
  await fakeRepo(paths.modelsDir, 'org/repo', {weights: 8192});

  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(first.id)}?weights=1`,
    });
    const body = response.json<{
      weightsRemoved: boolean;
      reclaimedBytes: number;
      sharedWithModelIds: string[];
    }>();

    assert.equal(body.weightsRemoved, false, 'the weights were NOT deleted');
    assert.equal(body.reclaimedBytes, 0);
    assert.deepEqual(body.sharedWithModelIds, [second.id], '...and the server says why');
    assert.equal(
      await repoDiskBytes(paths.modelsDir, 'org/repo'),
      8192,
      "the surviving model's weights are intact",
    );
  } finally {
    await app.close();
  }
});

test('a duplicate shares its original repo, so deleting one cannot strand the other', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const original = await store.addHuggingFaceModel({repoId: 'org/repo', quant: 'UD-Q4_K_M'});
  const copy: ConfiguredModel = await store.duplicateModel(original.id);
  await fakeRepo(paths.modelsDir, 'org/repo', {weights: 4096});

  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/models/${encodeURIComponent(copy.id)}?weights=1`,
    });
    assert.equal(response.json<{weightsRemoved: boolean}>().weightsRemoved, false);
    assert.equal(await repoDiskBytes(paths.modelsDir, 'org/repo'), 4096);
  } finally {
    await app.close();
  }
});
