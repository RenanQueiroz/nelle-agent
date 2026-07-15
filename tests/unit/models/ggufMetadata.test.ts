import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test, afterEach} from 'bun:test';

import {AppDatabase} from '../../../apps/server/src/db/database.ts';
import {
  GgufMetadataRepository,
  blobOidForModelPath,
  parseLocalGguf,
} from '../../../apps/server/src/models/gguf.ts';
import {ModelCacheRepository} from '../../../apps/server/src/models/cache.ts';
import {recordModelProps} from '../../../apps/server/src/llama/modelProps.ts';
import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';
import {minimalGgufBuffer} from '../helpers/gguf.ts';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A blob name is its sha256, so the fixtures use real-shaped ones. */
const OID_A = 'a'.repeat(64);
const OID_B = 'b'.repeat(64);

/**
 * Lays out a Hugging Face cache the way llama.cpp does: a content-addressed
 * `blobs/<sha256>` and a `snapshots/<commit>/<file>` symlink pointing at it.
 */
async function hfCache(
  root: string,
  input: {oid: string; commit: string; bytes: Buffer},
): Promise<string> {
  const blobs = path.join(root, 'blobs');
  const snapshot = path.join(root, 'snapshots', input.commit);
  await fs.mkdir(blobs, {recursive: true});
  await fs.mkdir(snapshot, {recursive: true});
  const blob = path.join(blobs, input.oid);
  await fs.writeFile(blob, input.bytes);
  const link = path.join(snapshot, 'model.gguf');
  await fs.symlink(blob, link);
  return link;
}

test('a hand-built header parses to its architecture and trained window', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-gguf-'));
  const file = path.join(directory, 'model.gguf');
  await fs.writeFile(
    file,
    minimalGgufBuffer({architecture: 'gemma4', contextLength: 262_144, parameterCount: 25_233}),
  );

  const parsed = await parseLocalGguf(file, OID_A);
  assert.equal(parsed.oid, OID_A);
  assert.equal(parsed.architecture, 'gemma4');
  // The key is namespaced by the architecture: `gemma4.context_length`.
  assert.equal(parsed.contextTrain, 262_144);
  assert.equal(parsed.parameterCount, 25_233);
});

test('a model path that is a symlink resolves to its blob oid', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-gguf-'));
  const link = await hfCache(directory, {
    oid: OID_A,
    commit: '02749a7b',
    bytes: minimalGgufBuffer(),
  });
  assert.equal(await blobOidForModelPath(link), OID_A);

  // Two snapshots of one repo can point at the same blob: the repo changed, the
  // model file did not. Keying on the commit would throw away a good cache.
  const second = path.join(directory, 'snapshots', 'c1f25db7');
  await fs.mkdir(second, {recursive: true});
  const other = path.join(second, 'model.gguf');
  await fs.symlink(path.join(directory, 'blobs', OID_A), other);
  assert.equal(await blobOidForModelPath(other), OID_A);

  // A file the user placed themselves has no content hash to key on.
  const loose = path.join(directory, 'my-model.gguf');
  await fs.writeFile(loose, minimalGgufBuffer());
  assert.equal(await blobOidForModelPath(loose), null);
  assert.equal(await blobOidForModelPath(path.join(directory, 'gone.gguf')), null);
});

test('an unchanged oid re-parses nothing; a changed one replaces the metadata', async () => {
  const paths = await createTempPaths();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-gguf-'));
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new GgufMetadataRepository(database);
    const first = path.join(directory, 'first.gguf');
    await fs.writeFile(first, minimalGgufBuffer({architecture: 'old', contextLength: 4096}));

    assert.equal((await repository.ensureParsed(OID_A, first)).contextTrain, 4096);

    // The same oid: the file cannot have changed, so the header is not re-read.
    // Point it at a file that would parse differently, and prove it does not.
    const changed = path.join(directory, 'changed.gguf');
    await fs.writeFile(changed, minimalGgufBuffer({architecture: 'new', contextLength: 131_072}));
    const cached = await repository.ensureParsed(OID_A, changed);
    assert.equal(cached.architecture, 'old', 'a content hash cannot be stale');
    assert.equal(cached.contextTrain, 4096);

    // A different oid means the model was updated upstream: read it again.
    const updated = await repository.ensureParsed(OID_B, changed);
    assert.equal(updated.architecture, 'new');
    assert.equal(updated.contextTrain, 131_072);
    // Both rows live: two blobs, two answers.
    assert.equal(repository.get(OID_A)?.contextTrain, 4096);
    assert.equal(repository.get(OID_B)?.contextTrain, 131_072);
  } finally {
    database.close();
  }
});

test('a successful /props records the oid and parses the header, offline', async () => {
  // The only honest test of "works offline": every network call throws.
  globalThis.fetch = (() => {
    throw new Error('the network is not available');
  }) as unknown as typeof fetch;

  const paths = await createTempPaths();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-gguf-'));
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const link = await hfCache(directory, {
      oid: OID_A,
      commit: 'c1f25db7',
      bytes: minimalGgufBuffer({architecture: 'gemma4', contextLength: 262_144}),
    });
    const modelCache = new ModelCacheRepository(database);
    const ggufMetadata = new GgufMetadataRepository(database);

    await recordModelProps({
      sectionId: 'repo/model:Q4',
      props: {
        modelId: 'repo/model:Q4',
        modalities: {vision: true, audio: false, video: false},
        contextWindow: 32_768,
        canReason: true,
        raw: {model_path: link},
      },
      modelCache,
      ggufMetadata,
    });

    const cached = modelCache.getModel('repo/model:Q4');
    assert.equal(cached?.modelOid, OID_A);
    assert.equal(cached?.contextWindow, 32_768);

    // The trained window, known without the router ever reporting `n_ctx_train`.
    const parsed = ggufMetadata.get(OID_A);
    assert.equal(parsed?.architecture, 'gemma4');
    assert.equal(parsed?.contextTrain, 262_144);
  } finally {
    database.close();
  }
});

test('a props answer with no model path caches the props and nothing else', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const modelCache = new ModelCacheRepository(database);
    const ggufMetadata = new GgufMetadataRepository(database);
    const props = {
      modelId: 'repo/model:Q4',
      modalities: {vision: false, audio: false, video: false},
      canReason: null,
      raw: {},
    };
    await recordModelProps({sectionId: 'repo/model:Q4', props, modelCache, ggufMetadata});
    assert.equal(modelCache.getModel('repo/model:Q4')?.modelOid, undefined);

    // A header that will not parse is a missing detail, never a failed turn.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-gguf-'));
    const link = await hfCache(directory, {
      oid: OID_B,
      commit: 'deadbeef',
      bytes: Buffer.from('not a gguf file at all'),
    });
    const errors: unknown[] = [];
    await recordModelProps({
      sectionId: 'repo/model:Q4',
      props: {...props, raw: {model_path: link}},
      modelCache,
      ggufMetadata,
      onError: error => errors.push(error),
    });
    // The oid is still recorded, so a later good parse has something to compare.
    assert.equal(modelCache.getModel('repo/model:Q4')?.modelOid, OID_B);
    assert.equal(errors.length, 1);
    assert.equal(ggufMetadata.get(OID_B), null);
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
    workspaceDir: dataDir,
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

test('the search asks for the parsed GGUF, and for the sizes it never got', async () => {
  const {HuggingFaceService} = await import('../../../apps/server/src/models/huggingface.ts');
  const {AppStore} = await import('../../../apps/server/src/models/store.ts');
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/models?')) {
      return new Response(
        JSON.stringify([
          {
            id: 'unsloth/gemma-4-26B-A4B-it-qat-GGUF',
            author: 'unsloth',
            downloads: 5,
            likes: 1,
            tags: ['gguf'],
            gguf: {total: 25_233_142_046, architecture: 'gemma4', context_length: 262_144},
          },
          // A repo Hugging Face could not parse. It degrades rather than throwing.
          {id: 'someone/plain-GGUF', downloads: 1},
        ]),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    }
    const repo = url.slice(url.lastIndexOf('/models/') + 8, url.indexOf('?'));
    return new Response(
      JSON.stringify({
        id: repo,
        siblings: [
          {rfilename: 'model-UD-Q4_K_XL.gguf', size: 14_249_045_120},
          {rfilename: 'mmproj-model.gguf', size: 1},
        ],
      }),
      {status: 200, headers: {'content-type': 'application/json'}},
    );
  }) as typeof fetch;

  const paths = await createTempPaths();
  const results = await new HuggingFaceService(new AppStore(paths)).searchGgufModels('gemma');

  // One list request, expanded, then one per repo purely for `size`.
  const [list] = urls;
  assert.match(list!, /expand%5B%5D=gguf/);
  assert.match(list!, /expand%5B%5D=siblings/);
  assert.ok(
    urls.slice(1).every(url => url.endsWith('?blobs=true')),
    'sizes need blobs=true',
  );

  const [gemma, plain] = results;
  assert.equal(gemma?.architecture, 'gemma4');
  assert.equal(gemma?.parameterCount, 25_233_142_046);
  assert.equal(gemma?.contextTrain, 262_144);
  // `size: null` for every file was the bug: nothing rendered it, so nobody saw.
  assert.equal(gemma?.quants[0]?.size, 14_249_045_120);
  assert.equal(gemma?.files[0]?.size, 14_249_045_120);
  // `mmproj-` is a projector, not a model.
  assert.equal(gemma?.files.length, 1);

  // No `gguf` block: name and downloads, rather than a thrown search.
  assert.equal(plain?.architecture, undefined);
  assert.equal(plain?.contextTrain, undefined);
  assert.equal(plain?.downloads, 1);
});
