import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeChatPerformance,
  performanceFromLlamaTimings,
} from '../../apps/server/src/llamaThroughput.ts';

test('a timings reading beats a slots reading, whichever arrives last', () => {
  const slots = {
    source: 'llamacpp-slots' as const,
    prompt: {tokens: 10, tokensPerSecond: 5},
    generation: {tokens: 1, tokensPerSecond: 2},
  };
  const timings = {
    source: 'llamacpp-timings' as const,
    prompt: {tokens: 44, tokensPerSecond: 32.3},
    generation: {tokens: 6, tokensPerSecond: 21.5},
  };

  // `/slots` is a best-effort poll; `timings` comes from the completion itself.
  assert.deepEqual(mergeChatPerformance(timings, slots).generation, timings.generation);
  assert.equal(mergeChatPerformance(timings, slots).source, 'llamacpp-timings');
  assert.deepEqual(mergeChatPerformance(slots, timings).generation, timings.generation);
  assert.equal(mergeChatPerformance(slots, timings).source, 'llamacpp-timings');
});

test('a merged reading keeps a metric the newer reading does not carry', () => {
  const withPrompt = {source: 'llamacpp-timings' as const, prompt: {tokens: 44, totalTokens: 128}};
  const withGeneration = {source: 'llamacpp-timings' as const, generation: {tokens: 6}};
  const merged = mergeChatPerformance(withPrompt, withGeneration);
  assert.deepEqual(merged.prompt, {tokens: 44, totalTokens: 128});
  assert.deepEqual(merged.generation, {tokens: 6});
});

test('the first reading passes through untouched', () => {
  const first = {source: 'llamacpp-timings' as const, generation: {tokens: 3, tokensPerSecond: 9}};
  assert.deepEqual(mergeChatPerformance(undefined, first), first);
});

test('the legacy throughput fields mirror the merged generation metric', () => {
  const merged = mergeChatPerformance(
    {source: 'llamacpp-slots', generation: {tokens: 1, tokensPerSecond: 2}},
    {source: 'llamacpp-timings', generation: {tokens: 6, tokensPerSecond: 21.5}},
  );
  assert.equal(merged.tokensPerSecond, 21.5);
  assert.equal(merged.generatedTokens, 6);
});

test('a sub-millisecond burst reports tokens but no rate', () => {
  // llama.cpp answers `predicted_per_second: 1000000` for one token in "0.00 ms".
  const performance = performanceFromLlamaTimings({
    predicted_n: 1,
    predicted_ms: 0,
    predicted_per_second: 1000000,
  });
  assert.equal(performance?.generation?.tokens, 1);
  assert.equal(performance?.generation?.tokensPerSecond, undefined);
});
