import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {emptyAnswerError, squeezedReplyBudgetWarning} from '../../apps/server/src/piHarness.ts';

test('a provider error is reported as itself, not reinterpreted', () => {
  const error = emptyAnswerError({
    providerError: 'llama.cpp returned 500',
    maxTokens: 1,
    contextSize: 16384,
    imageCount: 3,
  });
  assert.equal(error.message, 'llama.cpp returned 500');
  assert.equal((error as {code?: string}).code, undefined);
});

test('an empty turn with a healthy reply budget keeps the old, honest message', () => {
  // Nothing here says the context was the problem, so nothing should claim it was.
  const error = emptyAnswerError({maxTokens: 4096, contextSize: 16384, imageCount: 0});
  assert.match(error.message, /completed without assistant text/);
  assert.equal((error as {code?: string}).code, undefined);

  // No request was observed at all: still not a clamp.
  assert.match(
    emptyAnswerError({contextSize: 16384, imageCount: 3}).message,
    /completed without assistant text/,
  );
});

test('a clamped budget with images names the images and the way out', () => {
  const error = emptyAnswerError({maxTokens: 1, contextSize: 16384, imageCount: 3});
  assert.equal((error as {code?: string}).code, 'reply_budget_exhausted');
  assert.equal((error as {retryable?: boolean}).retryable, false);
  assert.match(error.message, /3 images left no room for a reply/);
  assert.match(error.message, /1,200 tokens per image/);
  assert.match(error.message, /16,384 token context window/);
  assert.match(error.message, /Attach fewer images, or raise the context size/);
});

test('one image is one image, not "1 images"', () => {
  const error = emptyAnswerError({maxTokens: 1, contextSize: 4096, imageCount: 1});
  assert.match(error.message, /The image left no room for a reply/);
});

test('a clamped budget with no images blames the prompt, not the pictures', () => {
  const error = emptyAnswerError({maxTokens: 1, contextSize: 16384, imageCount: 0});
  assert.equal((error as {code?: string}).code, 'reply_budget_exhausted');
  assert.match(error.message, /The prompt left no room for a reply/);
  assert.match(error.message, /Run \/compact/);
  assert.doesNotMatch(error.message, /image/);
});

test('a budget too small to finish a sentence warns before the answer is cut off', () => {
  assert.match(squeezedReplyBudgetWarning(120) ?? '', /only 120 tokens for a reply/);
  assert.match(squeezedReplyBudgetWarning(255) ?? '', /Attach fewer files, run \/compact/);

  // 256 tokens is the floor for a usable reply, so it is not a warning.
  assert.equal(squeezedReplyBudgetWarning(256), null);
  assert.equal(squeezedReplyBudgetWarning(4096), null);
  // A clamped budget belongs to `emptyAnswerError`; warning too would say it twice.
  assert.equal(squeezedReplyBudgetWarning(1), null);
  assert.equal(squeezedReplyBudgetWarning(undefined), null);
});
