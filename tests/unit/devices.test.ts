import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {DeviceRepository} from '../../apps/server/src/devices.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {removeTemp} from './helpers/platform.ts';

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-devices-'));
  const paths = {
    dataDir: dir,
    settingsDbPath: path.join(dir, 'settings.sqlite'),
  } as unknown as AppPaths;
  const database = new AppDatabase(paths);
  await database.open();
  return {database, dir, repo: new DeviceRepository(database)};
}

test('pairing issues tokens, validates access, and refresh rotates', async () => {
  const {database, dir, repo} = await makeRepo();
  try {
    const {code} = repo.mintPairingCode();
    const tokens = repo.pair({code, name: 'iPhone', platform: 'ios'});
    assert.ok(tokens, 'a valid code pairs');
    assert.ok(tokens.accessToken && tokens.refreshToken);

    assert.ok(repo.validateAccessToken(tokens.accessToken));
    assert.equal(repo.validateAccessToken('garbage'), null);

    const rotated = repo.refresh(tokens.refreshToken);
    assert.ok(rotated, 'refresh succeeds');
    assert.ok(repo.validateAccessToken(rotated.accessToken));
    assert.equal(repo.validateAccessToken(tokens.accessToken), null, 'old access invalidated');
    assert.equal(repo.refresh(tokens.refreshToken), null, 'old refresh invalidated');
  } finally {
    database.close();
    await removeTemp(dir);
  }
});

test('pairing codes are single-use and unknown codes are rejected', async () => {
  const {database, dir, repo} = await makeRepo();
  try {
    const {code} = repo.mintPairingCode();
    assert.ok(repo.pair({code, name: 'a'}), 'first use works');
    assert.equal(repo.pair({code, name: 'a'}), null, 'second use rejected');
    assert.equal(repo.pair({code: 'NOTACODE', name: 'a'}), null, 'unknown code rejected');
  } finally {
    database.close();
    await removeTemp(dir);
  }
});

test('an expired access token does not validate, but refresh still works', async () => {
  const {database, dir, repo} = await makeRepo();
  try {
    const {code} = repo.mintPairingCode();
    const tokens = repo.pair({code, name: 'a'})!;
    database.connection
      .prepare('UPDATE device_tokens SET access_expires_at = ?')
      .run(new Date(Date.now() - 1000).toISOString());
    assert.equal(repo.validateAccessToken(tokens.accessToken), null, 'expired access rejected');
    const rotated = repo.refresh(tokens.refreshToken)!;
    assert.ok(repo.validateAccessToken(rotated.accessToken), 'refresh issues a live access token');
  } finally {
    database.close();
    await removeTemp(dir);
  }
});

test('list shows devices and revoke cascades tokens away', async () => {
  const {database, dir, repo} = await makeRepo();
  try {
    const {code} = repo.mintPairingCode();
    const tokens = repo.pair({code, name: 'Laptop', platform: 'macos'})!;
    const devices = repo.list();
    assert.equal(devices.length, 1);
    assert.equal(devices[0]!.name, 'Laptop');
    assert.equal(devices[0]!.platform, 'macos');
    const id = devices[0]!.id;

    assert.equal(repo.revoke(id), true);
    assert.equal(repo.list().length, 0);
    assert.equal(repo.validateAccessToken(tokens.accessToken), null, 'cascade removed the token');
    assert.equal(repo.revoke(id), false, 'revoking twice is false');
  } finally {
    database.close();
    await removeTemp(dir);
  }
});

test('a paired device is told its own id', async () => {
  // It has no other way to learn it: `GET /api/devices` is loopback-only, so a paired
  // phone could never know which row it is -- which it needs to say "this device", or
  // to remove itself. Pairing returned tokens and nothing else, and the client had
  // nothing to store.
  const {database, dir, repo} = await makeRepo();
  try {
    const {code} = repo.mintPairingCode();
    const tokens = repo.pair({code, name: 'phone', platform: 'android'});
    assert.ok(tokens);

    const listed = repo.list();
    assert.equal(listed.length, 1);
    assert.equal(tokens.deviceId, listed[0]!.id, 'the id it was given is the row it owns');

    // ...and it survives a refresh, because the device is the same device.
    const renewed = repo.refresh(tokens.refreshToken);
    assert.equal(renewed?.deviceId, tokens.deviceId);
  } finally {
    database.close();
    await removeTemp(dir);
  }
});
