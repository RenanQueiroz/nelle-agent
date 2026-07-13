import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {createTestServer} from './helpers/testServer.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';

function tempPaths(dataDir: string): AppPaths {
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');
  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    modelsDir: path.join(dataDir, 'models'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    uploadsDir: path.join(dataDir, 'uploads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
  };
}

async function makeServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-auth-'));
  const app = await createTestServer(tempPaths(dataDir));
  return {app, dataDir};
}

test('loopback is trusted; the LAN listener requires a device token', async () => {
  const {app, dataDir} = await makeServer();
  try {
    // loopback (default trusted) needs no token
    assert.equal((await app.inject({method: 'GET', url: '/api/commands'})).statusCode, 200);

    // LAN without a token is 401
    const denied = await app.inject({method: 'GET', url: '/api/commands', trusted: false});
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json<{error: {code: string}}>().error.code, 'unauthorized');

    // health stays open on the LAN (allowlisted)
    const health = await app.inject({method: 'GET', url: '/api/health', trusted: false});
    assert.equal(health.statusCode, 200);
  } finally {
    await app.close();
    await fs.rm(dataDir, {recursive: true, force: true});
  }
});

test('pairing issues a token that authorizes LAN requests; revoke cuts it off', async () => {
  const {app, dataDir} = await makeServer();
  try {
    const minted = (await app.inject({method: 'POST', url: '/api/pair/code'})).json<{
      code: string;
      qrPayload: {tlsPort: number; code: string};
    }>();
    assert.ok(minted.code);
    assert.equal(minted.qrPayload.code, minted.code);

    const paired = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: {code: minted.code, deviceName: 'iPhone', platform: 'ios'},
    });
    assert.equal(paired.statusCode, 200);
    const tokens = paired.json<{accessToken: string; refreshToken: string}>();
    assert.ok(tokens.accessToken && tokens.refreshToken);

    const authed = {authorization: `Bearer ${tokens.accessToken}`};
    assert.equal(
      (await app.inject({method: 'GET', url: '/api/commands', trusted: false, headers: authed}))
        .statusCode,
      200,
      'a LAN request with the token works',
    );

    const listed = (await app.inject({method: 'GET', url: '/api/devices'})).json<{
      devices: Array<{id: string; name: string}>;
    }>().devices;
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.name, 'iPhone');

    assert.equal(
      (await app.inject({method: 'DELETE', url: `/api/devices/${listed[0]!.id}`})).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({method: 'GET', url: '/api/commands', trusted: false, headers: authed}))
        .statusCode,
      401,
      'the revoked token no longer authorizes',
    );
  } finally {
    await app.close();
    await fs.rm(dataDir, {recursive: true, force: true});
  }
});

test('invalid pairing code and refresh token are rejected; refresh renews access', async () => {
  const {app, dataDir} = await makeServer();
  try {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/pair',
      payload: {code: 'NOPE', deviceName: 'x'},
    });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json<{error: {code: string}}>().error.code, 'pairing_code_invalid');

    const minted = (await app.inject({method: 'POST', url: '/api/pair/code'})).json<{
      code: string;
    }>();
    const tokens = (
      await app.inject({
        method: 'POST',
        url: '/api/pair',
        payload: {code: minted.code, deviceName: 'x'},
      })
    ).json<{refreshToken: string}>();

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {refreshToken: tokens.refreshToken},
    });
    assert.equal(refreshed.statusCode, 200);
    assert.ok(refreshed.json<{accessToken: string}>().accessToken);

    const badRefresh = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {refreshToken: 'garbage'},
    });
    assert.equal(badRefresh.statusCode, 401);
    assert.equal(badRefresh.json<{error: {code: string}}>().error.code, 'refresh_token_invalid');
  } finally {
    await app.close();
    await fs.rm(dataDir, {recursive: true, force: true});
  }
});

test('admin endpoints 404 on the LAN even with a valid token', async () => {
  const {app, dataDir} = await makeServer();
  try {
    const minted = (await app.inject({method: 'POST', url: '/api/pair/code'})).json<{
      code: string;
    }>();
    const tokens = (
      await app.inject({
        method: 'POST',
        url: '/api/pair',
        payload: {code: minted.code, deviceName: 'x'},
      })
    ).json<{accessToken: string}>();
    const authed = {authorization: `Bearer ${tokens.accessToken}`};

    // A valid token passes the auth gate, but admin endpoints are loopback-only,
    // so they look like they do not exist (404) rather than 403.
    assert.equal(
      (await app.inject({method: 'GET', url: '/api/devices', trusted: false, headers: authed}))
        .statusCode,
      404,
    );
    assert.equal(
      (await app.inject({method: 'POST', url: '/api/pair/code', trusted: false, headers: authed}))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    await fs.rm(dataDir, {recursive: true, force: true});
  }
});
