import {describe, expect, test} from 'bun:test';

import {attributeBlobs, seedPathsForQuant} from '../../../src/llama/downloadTotal.ts';
import type {RepoTreeFile} from '../../../src/models/huggingface.ts';

const file = (
  path: string,
  sizeBytes: number | null,
  ids: {lfsOid?: string; oid?: string} = {},
): RepoTreeFile => ({path, sizeBytes, lfsOid: ids.lfsOid ?? null, oid: ids.oid ?? null});

// A repo the way the tree API describes it: the quant, an accessory llama.cpp may fetch
// alongside it, and a small non-LFS file whose blob is named by its git oid instead.
const TREE: RepoTreeFile[] = [
  file('model-UD-Q4_K_XL.gguf', 2000, {lfsOid: 'aaa64'}),
  file('mmproj-BF16.gguf', 500, {lfsOid: 'bbb64'}),
  file('config.json', 40, {oid: 'cafe40'}),
];

describe('attributeBlobs', () => {
  test('prices observed blobs by their content ids', () => {
    expect(attributeBlobs(['aaa64', 'bbb64'], TREE)).toEqual({
      totalBytes: 2500,
      unattributed: [],
    });
  });

  test('a small non-LFS blob matches its git oid', () => {
    expect(attributeBlobs(['cafe40'], TREE).totalBytes).toBe(40);
  });

  test('the seed counts the quant before its blob appears', () => {
    // The accessory joins later by observation; until then the total is the quant alone.
    expect(attributeBlobs([], TREE, ['model-UD-Q4_K_XL.gguf']).totalBytes).toBe(2000);
    expect(attributeBlobs(['bbb64'], TREE, ['model-UD-Q4_K_XL.gguf']).totalBytes).toBe(2500);
  });

  test('a blob the tree cannot name forfeits the total', () => {
    // An understated total shows 100% and keeps downloading -- the lie this exists to kill.
    const parsed = attributeBlobs(['aaa64', 'deadbeef'], TREE);
    expect(parsed.totalBytes).toBeUndefined();
    expect(parsed.unattributed).toEqual(['deadbeef']);
  });

  test('a matched file with no known size forfeits the total', () => {
    const sizeless = [file('model-UD-Q4_K_XL.gguf', null, {lfsOid: 'aaa64'})];
    expect(attributeBlobs(['aaa64'], sizeless).totalBytes).toBeUndefined();
  });

  test('a partially-suffixed blob attributes like a finished one', () => {
    expect(attributeBlobs(['aaa64.downloadInProgress'], TREE).totalBytes).toBe(2000);
  });

  test('nothing observed and nothing seeded is no total, never zero', () => {
    expect(attributeBlobs([], TREE).totalBytes).toBeUndefined();
  });

  test('a blob counted twice through seed and observation is one file', () => {
    expect(attributeBlobs(['aaa64'], TREE, ['model-UD-Q4_K_XL.gguf']).totalBytes).toBe(2000);
  });
});

describe('seedPathsForQuant', () => {
  test('names the quant file the way llama.cpp does', () => {
    expect(seedPathsForQuant(TREE, 'UD-Q4_K_XL')).toEqual(['model-UD-Q4_K_XL.gguf']);
  });

  test('an accessory can never be reached by a quant tag', () => {
    // `find_best_model` applies the accessory filter before tag matching; the seed must too,
    // or an MTP head would be seeded as if it were the model (the old quant-picker drift).
    const withMtp = [...TREE, file('mtp-model-Q4_0.gguf', 60, {lfsOid: 'ccc64'})];
    expect(seedPathsForQuant(withMtp, 'Q4_0')).toEqual([]);
  });

  test('an unknown quant or no quant seeds nothing', () => {
    expect(seedPathsForQuant(TREE, 'Q9_Z')).toEqual([]);
    expect(seedPathsForQuant(TREE, null)).toEqual([]);
  });
});
