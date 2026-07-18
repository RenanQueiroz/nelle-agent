import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {createTempPaths} from '../helpers/paths.ts';
import {removeTemp} from '../helpers/platform.ts';
import {createTestServer} from '../helpers/testServer.ts';

/**
 * Two properties of the route table that are silently breakable.
 *
 * Both survived `server.ts` being split into `routes/*.ts`, and both would have survived breaking
 * too: each fails in a way that typechecks, lints, and leaves every other test green. So they are
 * pinned here rather than left to be re-derived by whoever moves a `router.get` next.
 */

/**
 * `Router.dispatch` matches in **insertion order**, and `:id` compiles to `([^/]+)` -- which matches
 * the literal string `global-params` perfectly well. Register `PATCH /api/models/:id` first and the
 * global-params route becomes unreachable: every write to the `[*]` section is instead an attempt to
 * patch a model whose id happens to be "global-params", answered `model_not_found`.
 *
 * It is the only such pair in the table, and route modules are exactly where someone reorders one.
 */
test('PATCH /api/models/global-params is not swallowed by PATCH /api/models/:id', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/models/global-params',
      payload: {params: {temp: '0.7'}},
    });

    assert.equal(response.statusCode, 200);

    // The proof it reached the global-params handler and not the :id one: it answers with the
    // catalog, carrying the `[*]` section it just wrote. `:id` would have answered `model_not_found`.
    const body = response.json<{globalModelParams: Record<string, string>}>();
    assert.equal(body.globalModelParams.temp, '0.7');
  } finally {
    await app.close();
    await removeTemp(paths.dataDir);
  }
});

/**
 * The auth gate runs in `handle()`, **before** `dispatch` -- so an unauthenticated LAN request is
 * refused whether or not the route it asked for exists. Move the gate into a route module (the
 * obvious thing to do while splitting `server.ts`) and it can only run on routes that matched, so a
 * nonexistent path falls through to the 404 handler: the LAN listener would then answer 401 for a
 * real route and 404 for a fake one, and an unauthenticated attacker could map the entire API by
 * diffing the two.
 *
 * `auth.test.ts` covers the gate itself, but only against routes that exist -- which is exactly the
 * case that stays green when the gate moves.
 */
test('an unauthenticated LAN request leaks no route existence: 401 for a route that does not exist', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const real = await app.inject({method: 'GET', url: '/api/commands', trusted: false});
    const fake = await app.inject({method: 'GET', url: '/api/no-such-route', trusted: false});

    assert.equal(real.statusCode, 401);
    assert.equal(
      fake.statusCode,
      401,
      'a nonexistent route must not answer 404 to an unauthed device',
    );
    assert.equal(fake.json<{error: {code: string}}>().error.code, 'unauthorized');

    // ...and on the trusted loopback listener the same path is an honest 404, so the gate is what
    // makes the difference rather than the router having quietly grown a catch-all.
    assert.equal((await app.inject({method: 'GET', url: '/api/no-such-route'})).statusCode, 404);
  } finally {
    await app.close();
    await removeTemp(paths.dataDir);
  }
});
