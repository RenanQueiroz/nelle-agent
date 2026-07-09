import assert from 'node:assert/strict';
import test from 'node:test';

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
