import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {AppDatabase} from '../../../apps/server/src/db/database.ts';
import {PreferencesRepository} from '../../../apps/server/src/settings/preferences.ts';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  DISPLAY_PREFERENCE_KEYS,
} from '../../../apps/server/src/contracts/displayPreferences.ts';
import {SETTINGS_REGISTRY} from '../../../apps/server/src/contracts/settings.ts';
import {DISPLAY_SETTINGS_SLUG} from '../../../apps/server/src/contracts/settingsKeys.ts';
import {createTestServer} from '../helpers/testServer.ts';
import {AppStore} from '../../../apps/server/src/models/store.ts';
import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';

test('preferences start empty rather than absent', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    assert.deepEqual(new PreferencesRepository(database).getPreferences(), {
      favoriteModelIds: [],
    });
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
    assert.deepEqual(new PreferencesRepository(database).getPreferences(), {
      favoriteModelIds: [],
    });
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
  const app = await createTestServer(paths);
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

test('the display toggles are a settings group, not a preference row', () => {
  // They were six booleans with a label and a help string sitting in the preferences
  // blob, so every client hand-built six checkboxes for them. That is exactly what the
  // registry renders, so they are the `display` group now and no client writes a
  // checkbox again.
  const group = SETTINGS_REGISTRY.find(entry => entry.slug === DISPLAY_SETTINGS_SLUG);
  assert.ok(group, 'display must be a registry group');
  assert.deepEqual(
    group.fields.map(field => field.key),
    DISPLAY_PREFERENCE_KEYS,
    'every toggle moved, and only the toggles',
  );
  for (const field of group.fields) {
    assert.equal(field.type, 'boolean');
    assert.ok(field.label.length > 0);
    assert.ok(field.help.length > 0, "the help text came with them; it is the server's to write");
  }

  // The defaults came with them, unchanged. `renderUserContentAsMarkdown` is off because
  // the user typed plain text: their asterisks stay asterisks.
  const byKey = new Map(group.fields.map(field => [field.key, field]));
  for (const key of DISPLAY_PREFERENCE_KEYS) {
    assert.equal(byKey.get(key)?.default, DEFAULT_DISPLAY_PREFERENCES[key], key);
  }
});

test('a key this build does not know survives a write by one that does not know it', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    // A newer client wrote a preference this build has never heard of. Eating it
    // would lose the setting the moment the user opens an older client, and there
    // is no migration path through a phone's cache.
    database.connection
      .prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(
        'preferences',
        JSON.stringify({favoriteModelIds: ['a'], fromTheFuture: 'keep me'}),
        new Date().toISOString(),
      );
    const preferences = new PreferencesRepository(database);
    preferences.updatePreferences({favoriteModelIds: ['a', 'b']});

    const stored = JSON.parse(
      (
        database.connection
          .prepare('SELECT value_json FROM settings WHERE key = ?')
          .get('preferences') as {value_json: string}
      ).value_json,
    ) as Record<string, unknown>;
    assert.equal(stored.fromTheFuture, 'keep me');
    assert.deepEqual(stored.favoriteModelIds, ['a', 'b']);
  } finally {
    database.close();
  }
});

test('a preferences payload that is not a string array is rejected, not stored', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
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
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    workspaceDir: dataDir,
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
