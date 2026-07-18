import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {abortSessionRetry} from '../../../src/pi/harness.ts';

test('a void abortRetry does not take the abort down with it', async () => {
  // Pi's in-process AgentSession declares `abortRetry(): void`. Treating the
  // result as a promise threw a TypeError before `session.abort()` ever ran, so
  // the stop button answered 500 and the run kept generating.
  let called = 0;
  await abortSessionRetry({
    abortRetry: () => {
      called += 1;
    },
  });
  assert.equal(called, 1);
});

test('a promise-returning abortRetry is awaited', async () => {
  // Pi's RPC client declares `abortRetry(): Promise<void>`.
  let resolved = false;
  await abortSessionRetry({
    abortRetry: async () => {
      await Promise.resolve();
      resolved = true;
    },
  });
  assert.equal(resolved, true);
});

test('a failing abortRetry is swallowed, because the abort still has to happen', async () => {
  await abortSessionRetry({
    abortRetry: () => {
      throw new Error('no retry in flight');
    },
  });
  await abortSessionRetry({abortRetry: () => Promise.reject(new Error('rpc down'))});
});

test('a session with no abortRetry is not an error', async () => {
  await abortSessionRetry({});
});
