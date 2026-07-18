import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {createLiveContextTracker} from '../../../src/conversations/context.ts';

import {
  CONTEXT_OVERFLOW_RATIO,
  CONTEXT_WARNING_RATIO,
  contextUsageRatio,
  contextUsageStatus,
  withContextStatus,
} from '../../../src/contracts/context.ts';

test('the thresholds live in one place, and it is not the browser', () => {
  assert.equal(CONTEXT_WARNING_RATIO, 0.8);
  assert.equal(CONTEXT_OVERFLOW_RATIO, 1);
  const at = (usedTokens: number) => contextUsageStatus({usedTokens, totalTokens: 1000});
  assert.equal(at(799), 'ok');
  // Exactly 80% already warns; exactly full is an overflow, not a warning.
  assert.equal(at(800), 'warning');
  assert.equal(at(1000), 'overflow');
  // A zero total is not a measurement, so it cannot be a threshold breach.
  assert.equal(contextUsageStatus({usedTokens: 100, totalTokens: 0}), 'ok');
  assert.equal(contextUsageRatio({usedTokens: 100, totalTokens: 0}), null);
});

test('withContextStatus stamps a payload without disturbing its other fields', () => {
  assert.deepEqual(withContextStatus({usedTokens: 900, totalTokens: 1000, source: 'timings'}), {
    usedTokens: 900,
    totalTokens: 1000,
    source: 'timings',
    status: 'warning',
  });
});

test('the live context tracker adds generated tokens and skips repeat ticks', () => {
  const track = createLiveContextTracker(1000);
  // `prompt.totalTokens` is the full prompt; `prompt.tokens` is only what was
  // processed this turn, so the former wins when both are present.
  const first = track({
    source: 'llamacpp-timings',
    prompt: {tokens: 10, totalTokens: 700},
    generation: {tokens: 5},
  });
  assert.deepEqual(
    {usedTokens: first?.usedTokens, totalTokens: first?.totalTokens, source: first?.source},
    {usedTokens: 705, totalTokens: 1000, source: 'timings'},
  );

  // The same reading again would be one event per generated token. Skip it.
  assert.equal(
    track({
      source: 'llamacpp-timings',
      prompt: {tokens: 10, totalTokens: 700},
      generation: {tokens: 5},
    }),
    null,
  );

  const grown = track({
    source: 'llamacpp-timings',
    prompt: {tokens: 10, totalTokens: 700},
    generation: {tokens: 101},
  });
  assert.equal(grown?.usedTokens, 801);
});

test('the live context tracker stays silent until llama.cpp has counted a prompt', () => {
  const track = createLiveContextTracker(1000);
  assert.equal(track(undefined), null);
  assert.equal(track({source: 'llamacpp-slots'}), null);
  assert.equal(track({source: 'llamacpp-slots', generation: {tokens: 4}}), null);
});

test('an unknown context size still yields a usable reading', () => {
  const track = createLiveContextTracker(undefined);
  const reading = track({
    source: 'llamacpp-timings',
    prompt: {tokens: 40},
    generation: {tokens: 2},
  });
  assert.equal(reading?.usedTokens, 42);
  assert.equal(reading?.totalTokens, undefined);
  // With no window, no threshold can be breached.
  assert.equal(contextUsageStatus(reading ?? {}), 'ok');
});

test('the tracker does not put one context event on the wire per generated token', () => {
  let clock = 0;
  const track = createLiveContextTracker(10_000, {minIntervalMs: 250, now: () => clock});
  const tick = (generated: number) =>
    track({
      source: 'llamacpp-timings',
      prompt: {totalTokens: 100},
      generation: {tokens: generated},
    });

  assert.notEqual(tick(1), null, 'the first reading always goes out');
  // Twenty tokens inside the window: the count changes every time, but the bar
  // cannot show a difference, so nothing is emitted.
  for (let generated = 2; generated <= 21; generated += 1) {
    clock += 10;
    assert.equal(tick(generated), null);
  }
  clock += 250;
  assert.notEqual(tick(22), null, 'the window reopens');
});

test('crossing a threshold recolours the bar without waiting for the throttle', () => {
  let clock = 0;
  const track = createLiveContextTracker(1000, {minIntervalMs: 10_000, now: () => clock});
  const tick = (generated: number) =>
    track({
      source: 'llamacpp-timings',
      prompt: {totalTokens: 700},
      generation: {tokens: generated},
    });

  assert.equal(tick(1)?.usedTokens, 701);
  clock += 1;
  // Still 'ok', and inside the window: suppressed.
  assert.equal(tick(2), null);
  clock += 1;
  // 800/1000 is the warning threshold. It must not wait ten seconds to show.
  const warning = tick(100);
  assert.equal(warning?.usedTokens, 800);
  assert.equal(contextUsageStatus(warning ?? {}), 'warning');
  clock += 1;
  // And the overflow, likewise.
  const overflow = tick(300);
  assert.equal(contextUsageStatus(overflow ?? {}), 'overflow');
});
