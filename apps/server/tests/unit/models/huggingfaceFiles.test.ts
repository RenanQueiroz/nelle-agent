import assert from 'node:assert/strict';
import {describe, test} from 'bun:test';

import {
  extractGgufFiles,
  extractGgufQuants,
  isModelGguf,
  type HfSibling,
} from '../../../src/models/huggingface.ts';

/**
 * Which GGUF files a repo offers as models is llama.cpp's decision, not Nelle's:
 * `gguf_filename_is_model` runs inside `find_best_model` *before* the quant tag is
 * matched, so a file it rejects can never be downloaded by `hf-repo = <repo>:<TAG>`.
 * Nelle's copy of that rule had drifted, and the quant picker was offering accessories --
 * speculative-decoding heads -- as if they were models.
 *
 * The fixtures below are the **real** sibling lists of four repos, fetched from the Hugging
 * Face API. Two are polluted, two are clean, and the clean ones matter as much: a filter
 * that ate a real quant would be far worse than the bug it fixes.
 */

/** Our own production model. Four of the five quants it offered were MTP heads. */
const GEMMA_26B: HfSibling[] = [
  {rfilename: 'MTP/mtp-gemma-4-26B-A4B-it-BF16.gguf', size: 855_245_760},
  {rfilename: 'MTP/mtp-gemma-4-26B-A4B-it-F16.gguf', size: 855_245_760},
  {rfilename: 'MTP/mtp-gemma-4-26B-A4B-it-Q4_0.gguf', size: 251_937_728},
  {rfilename: 'MTP/mtp-gemma-4-26B-A4B-it-Q8_0.gguf', size: 461_784_000},
  {rfilename: 'gemma-4-26B-A4B-it-qat-UD-Q4_K_XL.gguf', size: 14_249_045_120},
  {rfilename: 'mmproj-BF16.gguf', size: 1_194_828_256},
  {rfilename: 'mmproj-F16.gguf', size: 1_193_058_784},
  {rfilename: 'mmproj-F32.gguf', size: 2_291_200_480},
  {rfilename: 'mtp-gemma-4-26B-A4B-it.gguf', size: 251_937_728},
];

/**
 * The richest case: an MTP head that *invents* a quant (`F16`, which this repo has no real
 * file for) and two that *corrupt* real ones (`BF16`, `Q8_0`), whose sizes were being summed
 * with the head's.
 */
const GEMMA_E2B: HfSibling[] = [
  {rfilename: 'MTP/mtp-gemma-4-E2B-it-BF16.gguf', size: 170_193_984},
  {rfilename: 'MTP/mtp-gemma-4-E2B-it-F16.gguf', size: 170_193_984},
  {rfilename: 'MTP/mtp-gemma-4-E2B-it-Q8_0.gguf', size: 97_817_664},
  {rfilename: 'gemma-4-E2B-it-BF16.gguf', size: 9_311_303_552},
  {rfilename: 'gemma-4-E2B-it-Q8_0.gguf', size: 5_048_350_848},
  {rfilename: 'gemma-4-E2B-it-UD-IQ2_M.gguf', size: 2_290_858_112},
  {rfilename: 'gemma-4-E2B-it-UD-Q4_K_XL.gguf', size: 3_184_494_720},
  {rfilename: 'mmproj-F16.gguf', size: 985_654_080},
  {rfilename: 'mtp-gemma-4-E2B-it.gguf', size: 97_817_664},
];

/**
 * The negative control that matters most. This repo's **name** carries an uppercase `MTP`,
 * none of its files do, and one of its quants is legitimately split across two shards.
 * Nothing here may be removed.
 */
const QWEN_35B_MTP: HfSibling[] = [
  {rfilename: 'BF16/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf', size: 49_913_715_456},
  {rfilename: 'BF16/Qwen3.6-35B-A3B-BF16-00002-of-00002.gguf', size: 21_152_227_104},
  {rfilename: 'Qwen3.6-35B-A3B-MXFP4_MOE.gguf', size: 22_182_574_368},
  {rfilename: 'Qwen3.6-35B-A3B-Q8_0.gguf', size: 37_801_097_504},
  {rfilename: 'Qwen3.6-35B-A3B-UD-IQ1_M.gguf', size: 11_366_414_624},
  {rfilename: 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf', size: 22_853_663_008},
  {rfilename: 'mmproj-BF16.gguf', size: 902_822_528},
  {rfilename: 'mmproj-F16.gguf', size: 899_283_584},
];

/** A different publisher, to prove the rule is not tuned to unsloth's conventions. */
const BARTOWSKI_GEMMA_3: HfSibling[] = [
  {rfilename: 'google_gemma-3-12b-it-IQ2_M.gguf', size: 4_310_290_464},
  {rfilename: 'google_gemma-3-12b-it-Q4_K_M.gguf', size: 7_300_000_000},
  {rfilename: 'mmproj-google_gemma-3-12b-it-bf16.gguf', size: 851_000_000},
  {rfilename: 'mmproj-google_gemma-3-12b-it-f16.gguf', size: 851_000_000},
  {rfilename: 'mmproj-google_gemma-3-12b-it-f32.gguf', size: 1_700_000_000},
];

const quantsOf = (siblings: HfSibling[]) =>
  extractGgufQuants(extractGgufFiles(siblings)).map(entry => entry.quant);

describe('isModelGguf: a port of llama.cpp gguf_filename_is_model', () => {
  test('rejects the three accessories llama.cpp downloads beside a model', () => {
    // Each is fetched *alongside* the chosen model, never instead of it -- so none of them
    // is ever the answer to "which file does this quant tag mean?".
    assert.equal(isModelGguf('MTP/mtp-gemma-4-E2B-it-F16.gguf'), false);
    assert.equal(isModelGguf('mmproj-F16.gguf'), false);
    assert.equal(isModelGguf('imatrix_unsloth.gguf'), false);
  });

  test('matches mmproj as a substring, not a prefix', () => {
    // Nelle checked `startsWith('mmproj-')`; llama.cpp checks `find("mmproj")`. A publisher
    // that puts the model name first would have sailed straight through.
    assert.equal(isModelGguf('mmproj-google_gemma-3-12b-it-f16.gguf'), false);
    assert.equal(isModelGguf('google_gemma-3-12b-it-mmproj-f16.gguf'), false);
  });

  test('is case-sensitive, and that is load-bearing', () => {
    // llama.cpp's `find("mtp-")` does not fold case, so a file whose name carries an
    // uppercase `MTP` IS a model to llama.cpp -- and Nelle must agree, or it would hide a
    // model llama.cpp is perfectly willing to download. This is also the guard that keeps a
    // repo named `...-MTP-GGUF` from being emptied by a lowercasing filter.
    assert.equal(isModelGguf('Qwen3.6-35B-A3B-MTP-UD-Q4_K_XL.gguf'), true);
    assert.equal(isModelGguf('mtp-Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'), false);
  });

  test('keeps ordinary models, shards and subdirectories', () => {
    assert.equal(isModelGguf('gemma-4-E2B-it-UD-Q4_K_XL.gguf'), true);
    assert.equal(isModelGguf('BF16/Qwen3.6-35B-A3B-BF16-00001-of-00002.gguf'), true);
    assert.equal(isModelGguf('README.md'), false);
  });
});

describe('the quant picker offers only what llama.cpp would resolve', () => {
  test('gemma-4-26B: four of its five quants were speculative-decoding heads', () => {
    // Before the port this repo -- the one this project actually runs -- offered
    // Q4_0, Q8_0, BF16 and F16, every one of them an MTP head, plus the one real model.
    // Picking any of the four wrote a models.ini entry that could never load.
    assert.deepEqual(quantsOf(GEMMA_26B), ['UD-Q4_K_XL']);
  });

  test('gemma-4-E2B: a fabricated quant goes, and two corrupted ones are repaired', () => {
    const quants = extractGgufQuants(extractGgufFiles(GEMMA_E2B));
    const byQuant = new Map(quants.map(entry => [entry.quant, entry]));

    // `F16` existed *only* as an MTP head: the repo has no F16 model at all, so the row was
    // pure fiction -- 170 MB offered for a 4.6B model.
    assert.equal(byQuant.has('F16'), false);

    // `BF16` and `Q8_0` are real, and each had its head summed into its size and counted as
    // a second file. A user reading "across 2 files" was being told about an accessory.
    assert.deepEqual(
      byQuant.get('BF16')?.files.map(file => file.filename),
      ['gemma-4-E2B-it-BF16.gguf'],
    );
    assert.equal(byQuant.get('BF16')?.size, 9_311_303_552);
    assert.deepEqual(
      byQuant.get('Q8_0')?.files.map(file => file.filename),
      ['gemma-4-E2B-it-Q8_0.gguf'],
    );
    assert.equal(byQuant.get('Q8_0')?.size, 5_048_350_848);

    assert.deepEqual(quantsOf(GEMMA_E2B), ['UD-IQ2_M', 'UD-Q4_K_XL', 'Q8_0', 'BF16']);
  });

  test('a clean repo loses nothing, and its split quant stays split', () => {
    // The rule must be inert where there is nothing to remove. `BF16` here is genuinely two
    // shards -- llama.cpp takes shard 1 and `get_split_files` collects the rest -- so summing
    // them and saying "across 2 files" is correct, and a filter that deduped to one file per
    // quant would have broken exactly this.
    const bf16 = extractGgufQuants(extractGgufFiles(QWEN_35B_MTP)).find(
      entry => entry.quant === 'BF16',
    );
    assert.equal(bf16?.files.length, 2);
    assert.equal(bf16?.size, 49_913_715_456 + 21_152_227_104);

    assert.deepEqual(quantsOf(QWEN_35B_MTP), [
      'UD-IQ1_M',
      'MXFP4_MOE',
      'UD-Q4_K_XL',
      'Q8_0',
      'BF16',
    ]);
  });

  test('another publisher loses nothing either', () => {
    assert.deepEqual(quantsOf(BARTOWSKI_GEMMA_3), ['IQ2_M', 'Q4_K_M']);
  });
});
