import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {DeviceRepository} from '../../apps/server/src/devices.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';

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
    await fs.rm(dir, {recursive: true, force: true});
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
    await fs.rm(dir, {recursive: true, force: true});
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
    await fs.rm(dir, {recursive: true, force: true});
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
    await fs.rm(dir, {recursive: true, force: true});
  }
});
