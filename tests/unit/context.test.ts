import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONTEXT_OVERFLOW_RATIO,
  CONTEXT_WARNING_RATIO,
  contextUsageRatio,
  contextUsageStatus,
  withContextStatus,
} from '../../packages/shared/src/context.ts';
import {
  contextProgressVariant,
  getContextOverflowMessage,
  getContextWarningMessage,
} from '../../apps/web/src/utils/context.ts';

const usage = (usedTokens: number, totalTokens = 100) => ({usedTokens, totalTokens});

test('the context bar turns amber at 80% and red at 100%', () => {
  assert.equal(contextProgressVariant(usage(79)), 'accent');
  assert.equal(contextProgressVariant(usage(80)), 'warning');
  assert.equal(contextProgressVariant(usage(99)), 'warning');
  assert.equal(contextProgressVariant(usage(100)), 'error');
  assert.equal(contextProgressVariant(usage(120)), 'error');
});

test('a near-full context warns, and a full one blocks', () => {
  // Below the threshold neither fires; the composer stays quiet.
  assert.equal(getContextWarningMessage(usage(79)), null);
  assert.equal(getContextOverflowMessage(usage(79)), null);

  // The warning is a bottom status; it must not also read as an error.
  assert.match(getContextWarningMessage(usage(85)) ?? '', /85% full/);
  assert.equal(getContextOverflowMessage(usage(85)), null);

  // At capacity the warning yields to the blocking error.
  assert.equal(getContextWarningMessage(usage(100)), null);
  assert.match(getContextOverflowMessage(usage(100)) ?? '', /context window is full/);
});

test('unknown context usage never fabricates a threshold', () => {
  assert.equal(contextProgressVariant({}), 'accent');
  assert.equal(getContextWarningMessage({}), null);
  assert.equal(getContextOverflowMessage({}), null);
  assert.equal(getContextOverflowMessage({usedTokens: 5}), null);
});

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

test('the client colours the bar from the status the server sent', () => {
  // The counts deliberately contradict the status: the server's answer wins,
  // because the threshold is only allowed to live in one place.
  const lying = {usedTokens: 10, totalTokens: 1000, status: 'overflow'} as const;
  assert.equal(contextProgressVariant(lying), 'error');
  assert.match(getContextOverflowMessage(lying) ?? '', /context window is full/);
  assert.equal(getContextWarningMessage(lying), null);

  const quiet = {usedTokens: 900, totalTokens: 1000, status: 'ok'} as const;
  assert.equal(contextProgressVariant(quiet), 'accent');
  assert.equal(getContextWarningMessage(quiet), null);
});
