import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {PreferencesRepository} from '../../apps/server/src/preferences.ts';
import {createServer} from '../../apps/server/src/server.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';

test('preferences start empty rather than absent', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    assert.deepEqual(new PreferencesRepository(database).getPreferences(), {favoriteModelIds: []});
  } finally {
    database.close();
  }
});

test('favorites round-trip, keep the user order, and drop duplicates', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const preferences = new PreferencesRepository(database);
    preferences.updatePreferences({favoriteModelIds: ['b', 'a', 'b']});
    // The star order is the user's; the first occurrence of an id wins.
    assert.deepEqual(preferences.getPreferences().favoriteModelIds, ['b', 'a']);

    // A new repository over the same database sees them: this is the whole point.
    assert.deepEqual(new PreferencesRepository(database).getPreferences().favoriteModelIds, [
      'b',
      'a',
    ]);
  } finally {
    database.close();
  }
});

test('a favorite for a removed model is hidden, not destroyed', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const preferences = new PreferencesRepository(database);
    preferences.updatePreferences({favoriteModelIds: ['kept', 'removed']});

    // `models.ini` no longer lists `removed`, so it is filtered out of the read.
    assert.deepEqual(preferences.getPreferences(['kept']).favoriteModelIds, ['kept']);
    // But a model that comes back brings its star with it.
    assert.deepEqual(preferences.getPreferences(['kept', 'removed']).favoriteModelIds, [
      'kept',
      'removed',
    ]);
  } finally {
    database.close();
  }
});

test('a corrupt preferences row does not take the server down', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    database.connection
      .prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('preferences', '{not json', new Date().toISOString());
    assert.deepEqual(new PreferencesRepository(database).getPreferences(), {favoriteModelIds: []});
  } finally {
    database.close();
  }
});

test('the preferences routes filter unknown models without persisting the filter', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const app = await createServer(paths);
  try {
    assert.deepEqual((await app.inject({method: 'GET', url: '/api/settings/preferences'})).json(), {
      favoriteModelIds: [],
    });

    const saved = (
      await app.inject({
        method: 'PATCH',
        url: '/api/settings/preferences',
        payload: {favoriteModelIds: [model.id, 'ghost/model']},
      })
    ).json<{favoriteModelIds: string[]}>();
    assert.deepEqual(saved.favoriteModelIds, [model.id]);

    // And the read filters it too, not just the write that rejected it.
    assert.deepEqual((await app.inject({method: 'GET', url: '/api/settings/preferences'})).json(), {
      favoriteModelIds: [model.id],
    });

    // The ghost was filtered from the response, not deleted from storage.
    const database = new AppDatabase(paths);
    await database.open();
    try {
      assert.deepEqual(new PreferencesRepository(database).getPreferences().favoriteModelIds, [
        model.id,
        'ghost/model',
      ]);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});

test('a preferences payload that is not a string array is rejected, not stored', async () => {
  const paths = await createTempPaths();
  const app = await createServer(paths);
  try {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/settings/preferences',
      payload: {favoriteModelIds: [42]},
    });
    assert.equal(response.statusCode, 400);
    const {error} = response.json<{error: {code: string; detail?: string}}>();
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.detail, 'favoriteModelIds.0');
  } finally {
    await app.close();
  }
});

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
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
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}
