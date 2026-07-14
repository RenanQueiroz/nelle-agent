import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  performanceFromLlamaTimings,
  sanitizeStoredPerformance,
} from '../../../apps/server/src/llama/throughput.ts';
import {
  availableReplyTokens,
  isClampedReplyBudget,
  maxAffordableImages,
  isReplyBudgetExhausted,
  MIN_USABLE_REPLY_TOKENS,
  minimumContextSizeForImages,
  minimumUsableContextSize,
  PI_CONTEXT_SAFETY_TOKENS,
  PI_AGENT_PROMPT_TOKENS,
  PI_ESTIMATED_IMAGE_TOKENS,
  PI_MIN_MAX_TOKENS,
  replyTokenBudget,
} from '../../../apps/server/src/contracts/piContext.ts';

// Pi's agent system prompt measured ~4.2k tokens against Qwen3.6 with tools off.
const AGENT_PROMPT_TOKENS = 4300;

test('an 8k context window leaves Pi no room to reply', () => {
  // This is the bug: Pi clamps max_tokens to 1 and llama.cpp stops after one
  // word with finish_reason "length".
  assert.equal(availableReplyTokens(8192, AGENT_PROMPT_TOKENS), 1);
  assert.equal(isReplyBudgetExhausted(8192, AGENT_PROMPT_TOKENS), true);
});

test('the default 16k context window leaves a usable reply budget', () => {
  assert.equal(availableReplyTokens(16_384, AGENT_PROMPT_TOKENS), replyTokenBudget(16_384));
  assert.equal(isReplyBudgetExhausted(16_384, AGENT_PROMPT_TOKENS), false);
});

test('reply budget scales with the context window instead of a flat 512 cap', () => {
  assert.equal(replyTokenBudget(8192), 2048);
  assert.equal(replyTokenBudget(16_384), 4096);
  assert.equal(replyTokenBudget(65_536), 8192);
  // Never proposes less than a full answer's worth of tokens.
  assert.equal(replyTokenBudget(1024), 1024);
  assert.equal(replyTokenBudget(0), 1024);
});

test('minimum usable context size accounts for Pi safety reserve', () => {
  const promptTokens = 4300;
  const minimum = minimumUsableContextSize(promptTokens);
  assert.ok(minimum > promptTokens + PI_CONTEXT_SAFETY_TOKENS);
  assert.equal(isReplyBudgetExhausted(minimum, promptTokens), false);
  assert.equal(isReplyBudgetExhausted(minimum - 1, promptTokens), true);
});

test('Pi charges a flat 1,200 tokens for every image it sends', () => {
  // `ESTIMATED_IMAGE_CHARS = 4800`, then chars/4. It is the same number for a
  // thumbnail and a poster, and llama.cpp charges around 120 for the pages Nelle
  // renders. Measured against the real server: max_tokens goes 1649, 449, 1 as
  // the first, second and third image are attached to a 16,384 token window.
  assert.equal(PI_ESTIMATED_IMAGE_TOKENS, 1200);

  const BASE = 9439; // Pi's system prompt plus the user text, measured.
  const budget = (images: number) =>
    availableReplyTokens(16384, BASE + images * PI_ESTIMATED_IMAGE_TOKENS);
  // These are the exact `max_tokens` values captured off the wire.
  assert.equal(budget(1), 1649);
  assert.equal(budget(2), 449);
  assert.ok(budget(2) > MIN_USABLE_REPLY_TOKENS);
  // The third image is the one that ends the turn with no answer.
  assert.equal(budget(3), PI_MIN_MAX_TOKENS);
});

test('the image budget matches what Pi actually allows', () => {
  // The default window fits exactly two: `max_tokens` goes 1649, 449, 1.
  assert.equal(maxAffordableImages(16384), 2);
  // An 8k window has no room for a reply once Pi has taken its system prompt and
  // its reserve, let alone an image.
  assert.equal(maxAffordableImages(8192), 0);
  assert.equal(maxAffordableImages(24576), 8);

  // The measured base is the whole of the arithmetic; nothing else is guessed.
  assert.equal(
    maxAffordableImages(16384),
    Math.floor(
      (16384 - PI_AGENT_PROMPT_TOKENS - PI_CONTEXT_SAFETY_TOKENS - MIN_USABLE_REPLY_TOKENS) /
        PI_ESTIMATED_IMAGE_TOKENS,
    ),
  );

  // History is deliberately left out, so an underestimate can only let a message
  // through that then fails, never refuse one that would have worked.
  assert.ok(maxAffordableImages(16384, PI_AGENT_PROMPT_TOKENS + 4000) < maxAffordableImages(16384));
});

test('a window that fits N images is the window minimumContextSizeForImages names', () => {
  for (const images of [1, 3, 6, 20]) {
    const needed = minimumContextSizeForImages(images, PI_AGENT_PROMPT_TOKENS);
    assert.ok(
      maxAffordableImages(needed) >= images,
      `${needed} tokens should carry ${images} images`,
    );
    // And one token less does not.
    assert.ok(maxAffordableImages(needed - PI_ESTIMATED_IMAGE_TOKENS) < images);
  }
});

test('a clamped reply budget is recognised from the wire, whatever caused it', () => {
  assert.equal(isClampedReplyBudget(1), true);
  assert.equal(isClampedReplyBudget(0), true);
  assert.equal(isClampedReplyBudget(2), false);
  assert.equal(isClampedReplyBudget(4096), false);
  // No request was seen; that is not a clamp.
  assert.equal(isClampedReplyBudget(undefined), false);
});

test('the context size that would fit N images is reported, not guessed at', () => {
  const BASE = 9439;
  const needed = minimumContextSizeForImages(3, BASE);
  assert.equal(
    needed,
    BASE + 3 * PI_ESTIMATED_IMAGE_TOKENS + PI_CONTEXT_SAFETY_TOKENS + MIN_USABLE_REPLY_TOKENS,
  );
  // And a window that size does leave a usable reply budget.
  assert.ok(
    availableReplyTokens(needed, BASE + 3 * PI_ESTIMATED_IMAGE_TOKENS) >= MIN_USABLE_REPLY_TOKENS,
  );
});

test('a one token burst reports no throughput instead of 1,000,000 t/s', () => {
  // Exactly what llama.cpp reports for `eval time = 0.00 ms / 1 tokens`.
  const performance = performanceFromLlamaTimings({
    prompt_n: 4238,
    prompt_ms: 18_283.784,
    prompt_per_second: 231.79,
    predicted_n: 1,
    predicted_ms: 0.001,
    predicted_per_second: 1_000_000,
  });

  assert.equal(performance?.generation?.tokens, 1);
  assert.equal(performance?.generation?.tokensPerSecond, undefined);
  assert.equal(performance?.tokensPerSecond, undefined);
  // The prompt burst is long enough to time, and the rate is derived, not copied.
  assert.ok(Math.abs((performance?.prompt?.tokensPerSecond ?? 0) - 231.79) < 1);
});

test('stored 1,000,000 t/s rates are stripped when a conversation is reopened', () => {
  const stored = {
    source: 'llamacpp-timings',
    prompt: {tokens: 4238, milliseconds: 18_283.784, tokensPerSecond: 231.79},
    generation: {tokens: 1, milliseconds: 0.001, tokensPerSecond: 1_000_000},
    tokensPerSecond: 1_000_000,
    generatedTokens: 1,
  };

  const sanitized = sanitizeStoredPerformance(stored) as typeof stored;

  assert.equal(sanitized.generation.tokensPerSecond, undefined);
  assert.equal(sanitized.tokensPerSecond, undefined);
  // Token counts and durations are a faithful record; only the rate was wrong.
  assert.equal(sanitized.generation.tokens, 1);
  assert.equal(sanitized.generation.milliseconds, 0.001);
  assert.equal(sanitized.prompt.tokensPerSecond, 231.79);
});

test('sanitizing performance leaves measurable rates untouched', () => {
  const stored = {
    source: 'llamacpp-timings',
    prompt: {tokens: 4337, milliseconds: 10_897.889, tokensPerSecond: 397.97},
    generation: {tokens: 29, milliseconds: 850.407, tokensPerSecond: 34.1},
    tokensPerSecond: 34.1,
  };

  assert.deepEqual(sanitizeStoredPerformance(stored), stored);
  assert.equal(sanitizeStoredPerformance(undefined), undefined);
  assert.equal(sanitizeStoredPerformance(null), null);

  // A metric that never recorded a duration cannot be judged, so keep its rate.
  const withoutDuration = {generation: {tokens: 3, tokensPerSecond: 12}};
  assert.deepEqual(sanitizeStoredPerformance(withoutDuration), withoutDuration);
});

test('throughput is derived from tokens and milliseconds, not the upstream rate', () => {
  const performance = performanceFromLlamaTimings({
    predicted_n: 29,
    predicted_ms: 850.407,
    // llama.cpp's own field disagrees; we must not trust it.
    predicted_per_second: 999,
  });

  const rate = performance?.generation?.tokensPerSecond ?? 0;
  assert.ok(Math.abs(rate - (29 / 850.407) * 1000) < 0.001, `unexpected rate ${rate}`);
});
