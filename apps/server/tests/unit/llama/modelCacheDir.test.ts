import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'bun:test';

import {modelCacheEnv} from '../../../src/llama/weights.ts';
import {createAppPaths} from '../../../src/lib/paths.ts';

/**
 * Model weights live inside Nelle's data directory, not in the user's global
 * `~/.cache/huggingface/hub`.
 *
 * They are the largest thing Nelle owns by two orders of magnitude and were the last of
 * its data living somewhere it did not control. Owning them means it can account for the
 * disk; it means "what llama.cpp has cached" is "what Nelle downloaded" (which matters,
 * because the router advertises *every* cached GGUF as loadable and has no flag to stop);
 * and it isolates a throwaway `NELLE_DATA_DIR`, which until now still reached into the
 * developer's real weights.
 */

const CACHE_VARS = ['LLAMA_CACHE', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'HF_HOME'];
const original = new Map(CACHE_VARS.map(name => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

function clearCacheVars(): void {
  for (const name of CACHE_VARS) {
    delete process.env[name];
  }
}

test('by default, llama.cpp downloads weights into the data directory', () => {
  clearCacheVars();
  assert.deepEqual(modelCacheEnv('/data/models'), {LLAMA_CACHE: '/data/models'});
});

test('the models directory follows NELLE_DATA_DIR, so a throwaway install downloads nothing of ours', () => {
  const previous = process.env.NELLE_DATA_DIR;
  // Built with `path.join`, not a string literal: `createAppPaths` uses the platform separator, so
  // a hardcoded POSIX path asserts `/tmp/throwaway/models` against `D:\tmp\throwaway\models` on
  // Windows and fails on a value that is entirely correct.
  const dataDir = path.join(os.tmpdir(), 'throwaway');
  process.env.NELLE_DATA_DIR = dataDir;
  try {
    assert.equal(createAppPaths().modelsDir, path.join(dataDir, 'models'));
  } finally {
    if (previous === undefined) {
      delete process.env.NELLE_DATA_DIR;
    } else {
      process.env.NELLE_DATA_DIR = previous;
    }
  }
});

test('an explicit cache wins, whichever of the four the user set', () => {
  // `common/hf-cache.cpp` resolves the hub root from LLAMA_CACHE, then HF_HUB_CACHE, then
  // HUGGINGFACE_HUB_CACHE, then HF_HOME. `LLAMA_CACHE` outranks all of them -- so setting
  // it would *silently overrule* a user who had chosen any of the others, whether to share
  // a cache with llama.cpp on the command line or to keep 50 GB on another disk. Someone
  // who set one of these has said what they want.
  for (const name of CACHE_VARS) {
    clearCacheVars();
    process.env[name] = '/somewhere/they/chose';
    assert.deepEqual(modelCacheEnv('/data/models'), {}, `${name} must not be overruled`);
  }
});
