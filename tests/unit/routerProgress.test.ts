import {describe, expect, test} from 'bun:test';

import {routerLoadProgress} from '../../apps/server/src/contracts/routerProgress.ts';

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
