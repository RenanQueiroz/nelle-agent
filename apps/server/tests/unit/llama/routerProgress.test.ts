import {describe, expect, test} from 'bun:test';

import {routerDownloadProgress, routerLoadProgress} from '../../../src/contracts/routerProgress.ts';

describe('routerLoadProgress', () => {
  test('collapses a staged load into a fraction of the whole load', () => {
    // Captured verbatim off llama.cpp's wire: a vision model loads in two stages and
    // `value` restarts at 0 for each.
    const at = (current: string, value: number) =>
      routerLoadProgress({stages: ['text_model', 'mmproj_model'], current, value});

    expect(at('text_model', 0)).toBe(0);
    expect(at('text_model', 0.5)).toBe(0.25);
    expect(at('text_model', 1)).toBe(0.5);
    // The second stage restarts at 0 -- and must not rewind the bar.
    expect(at('mmproj_model', 0)).toBe(0.5);
    expect(at('mmproj_model', 1)).toBe(1);
  });

  test('a bare stage announcement is not a measurement', () => {
    // llama.cpp emits this between stages. Reading it as 0 would rewind a load that is
    // already reporting.
    expect(routerLoadProgress({stage: 'mmproj_model'})).toBeUndefined();
  });

  test('a single-stage load reports its own value', () => {
    expect(routerLoadProgress({stages: ['text_model'], current: 'text_model', value: 0.4})).toBe(
      0.4,
    );
  });

  test('an unknown stage name falls back to the raw value', () => {
    expect(routerLoadProgress({stages: ['text_model'], current: 'who_knows', value: 0.4})).toBe(
      0.4,
    );
  });

  test('tolerates a bare number and an object with only a value', () => {
    expect(routerLoadProgress(0.67)).toBe(0.67);
    expect(routerLoadProgress({value: 0.67})).toBe(0.67);
  });

  test('clamps to 0..1 and refuses nonsense', () => {
    expect(routerLoadProgress({value: 1.5})).toBe(1);
    expect(routerLoadProgress({value: -1})).toBe(0);
    expect(routerLoadProgress(Number.NaN)).toBeUndefined();
    expect(routerLoadProgress(undefined)).toBeUndefined();
    expect(routerLoadProgress(null)).toBeUndefined();
    expect(routerLoadProgress('0.5')).toBeUndefined();
  });
});

describe('routerDownloadProgress', () => {
  test('sums bytes and totals across files downloading in parallel', () => {
    // The shape llama.cpp documents for `download_progress` frames: `data` keyed by URL,
    // because the model, its mmproj and any shards download at once.
    const parsed = routerDownloadProgress({
      'https://hf.co/model.gguf': {done: 195_963_406, total: 219_307_424},
      'https://hf.co/mmproj.gguf': {done: 1_000_000, total: 2_000_000},
    });
    expect(parsed?.downloadedBytes).toBe(196_963_406);
    expect(parsed?.totalBytes).toBe(221_307_424);
    expect(parsed?.fraction).toBeCloseTo(196_963_406 / 221_307_424);
  });

  test('a missing total means bytes only, never a made-up fraction', () => {
    // The map holds the files llama.cpp is *currently* fetching; a fraction computed from a
    // partial total would jump around as files enter and leave it.
    const parsed = routerDownloadProgress({
      'https://hf.co/model.gguf': {done: 500, total: 1000},
      'https://hf.co/mmproj.gguf': {done: 100},
    });
    expect(parsed?.downloadedBytes).toBe(600);
    expect(parsed?.totalBytes).toBeUndefined();
    expect(parsed?.fraction).toBeUndefined();
  });

  test('junk is undefined, never zero', () => {
    expect(routerDownloadProgress(undefined)).toBeUndefined();
    expect(routerDownloadProgress(null)).toBeUndefined();
    expect(routerDownloadProgress('downloading')).toBeUndefined();
    expect(routerDownloadProgress([])).toBeUndefined();
    expect(routerDownloadProgress({})).toBeUndefined();
    expect(routerDownloadProgress({'https://x': {done: 'many'}})).toBeUndefined();
    expect(routerDownloadProgress({'https://x': {done: -5}})).toBeUndefined();
  });

  test('never reports past 100% even if done overshoots total', () => {
    const parsed = routerDownloadProgress({'https://x': {done: 1100, total: 1000}});
    expect(parsed?.fraction).toBe(1);
  });
});
