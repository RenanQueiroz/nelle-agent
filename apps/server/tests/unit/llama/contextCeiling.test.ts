import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  CONTEXT_SIZE_KEYS,
  MAX_CONTEXT_EXTENSION_FACTOR,
  modelParamWarnings,
  validateModelParams,
} from '../../../src/contracts/modelParams.ts';

/**
 * **`c` is the one value Nelle checks, and only against a number llama.cpp reported.**
 *
 * Running past `n_ctx_train` is legitimate -- that is what RoPE/YaRN extension *is*, and
 * llama.cpp permits it with a warning of its own -- so any overshoot warns and none is
 * refused. But `c` bypasses `--fit` (which only adjusts arguments left unset), so llama.cpp
 * allocates a KV cache for whatever integer it is handed without ever asking how much memory
 * exists. `c = 900000000` does not fail the load: it takes the machine down, with no error and
 * no exit code, because nothing survives to write one. (Measured. That is how this test exists.)
 */

const TRAINED = 131_072; // gemma-4-E4B's real trained window.

/** The trained window is the only thing Nelle measures against, and it is llama.cpp's number. */
const withWindow = (params: Record<string, string>) =>
  validateModelParams(params, {trainedContextWindow: TRAINED});

test('a fat-fingered context size is refused, and the message names the real ceiling', () => {
  const invalid = withWindow({c: '900000000'});

  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.key, 'c');
  assert.equal(invalid[0]?.reason, 'out_of_range');
  assert.match(invalid[0]?.message ?? '', /900,000,000/);
  assert.match(invalid[0]?.message ?? '', /131,072/);
  // The one-tap fix is the ceiling itself, not a shrug.
  assert.equal(invalid[0]?.suggestion, String(TRAINED * MAX_CONTEXT_EXTENSION_FACTOR));
});

test('a YaRN-shaped extension is allowed, and warns rather than refusing', () => {
  // 4x is what Qwen's own model cards tell you to do.
  const fourX = String(TRAINED * 4);
  assert.deepEqual(withWindow({c: fourX}), []);

  const warnings = modelParamWarnings({c: fourX}, TRAINED);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.key, 'c');
  assert.match(warnings[0]?.message ?? '', /4\.0x/);
  // It must say *how* to make it work, or the warning is just a scold.
  assert.match(warnings[0]?.message ?? '', /YaRN/);
  assert.match(warnings[0]?.message ?? '', /rope-scaling/);
});

test('the ceiling is inclusive, and one token past it is refused', () => {
  const ceiling = TRAINED * MAX_CONTEXT_EXTENSION_FACTOR;
  assert.deepEqual(withWindow({c: String(ceiling)}), [], 'exactly the ceiling must be allowed');
  assert.equal(withWindow({c: String(ceiling + 1)})[0]?.reason, 'out_of_range');
});

test('a refused size does not also warn: one row, one message', () => {
  assert.deepEqual(modelParamWarnings({c: '900000000'}, TRAINED), []);
});

test('at or below the trained window nothing is said at all', () => {
  assert.deepEqual(withWindow({c: String(TRAINED)}), []);
  assert.deepEqual(modelParamWarnings({c: String(TRAINED)}, TRAINED), []);
  assert.deepEqual(modelParamWarnings({c: '32768'}, TRAINED), []);
});

test('`c = 0` is not a size and is never refused', () => {
  // `common/arg.cpp` reads 0 as "the user explicitly wants the full trained window" and
  // disables fit reduction. Refusing it would break the one way to remove a global cap.
  assert.deepEqual(withWindow({c: '0'}), []);
  assert.deepEqual(modelParamWarnings({c: '0'}, TRAINED), []);
});

test('every spelling of --ctx-size is guarded, because they are one option', () => {
  // `get_map_key_opt` (common/preset.cpp) accepts each argument spelling with its leading
  // dashes stripped, plus the env var. A guard that knew only `c` would be stepped around by
  // a user who happened to type `ctx-size` -- and llama.cpp would allocate all the same.
  for (const key of CONTEXT_SIZE_KEYS) {
    const invalid = withWindow({[key]: '900000000'});
    assert.equal(invalid[0]?.reason, 'out_of_range', `${key} must be guarded`);
    assert.equal(invalid[0]?.key, key);
  }
  assert.deepEqual([...CONTEXT_SIZE_KEYS].sort(), ['LLAMA_ARG_CTX_SIZE', 'c', 'ctx-size'].sort());
});

test('a model llama.cpp has never loaded has no window, so the ceiling does not fire', () => {
  // `n_ctx_train` is cached from a real load. Inventing a bound for a model Nelle has never
  // seen would refuse a legitimate long-context model the first time anyone tried to use it.
  assert.deepEqual(validateModelParams({c: '900000000'}, {trainedContextWindow: null}), []);
  assert.deepEqual(validateModelParams({c: '900000000'}, {}), []);
  assert.deepEqual(modelParamWarnings({c: '900000000'}, null), []);
});

test('`-C` is not `-c`: the guard is case-sensitive, like the catalogue', () => {
  // `-c` is --ctx-size and `-C` is --cpu-mask. A case-folding guard would refuse a CPU mask
  // for being too large a context, which is nonsense.
  assert.deepEqual(withWindow({C: '900000000'}), []);
});

test('a non-numeric context size is llama.cpp to reject, not Nelle to guess at', () => {
  assert.deepEqual(withWindow({c: 'lots'}), []);
  assert.deepEqual(withWindow({c: '-1'}), []);
});
