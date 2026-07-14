import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {AppDatabase} from '../../apps/server/src/db/database.ts';
import {SettingsRepository} from '../../apps/server/src/settings/repository.ts';
import {createTestServer} from './helpers/testServer.ts';
import type {AppPaths} from '../../apps/server/src/lib/paths.ts';
import {
  SETTINGS_REGISTRY,
  coerceSettingsValues,
  settingsValueSchema,
  settingsGroupDefaults,
  settingsGroupSchema,
  settingsPatchSchema,
  type SettingsGroup,
  runtimeLimitsFromSettings,
} from '../../apps/server/src/contracts/settings.ts';
import {RUNTIME_SETTINGS_SLUG} from '../../apps/server/src/contracts/settingsKeys.ts';

/**
 * The real registry is empty in this phase: it lands the machinery, and every
 * phase after it is one entry. So the machinery is driven here by a fixture
 * carrying one of each field type, and the real registry is checked only for the
 * invariants that must hold the moment it grows an entry.
 */
const FIXTURE: readonly SettingsGroup[] = [
  {
    slug: 'demo',
    title: 'Demo',
    fields: [
      {key: 'label', label: 'Label', help: 'A short string.', type: 'text', default: 'hello'},
      {
        key: 'prompt',
        label: 'Prompt',
        help: 'A long string.',
        type: 'textarea',
        default: '',
        maxLength: 16,
      },
      {
        key: 'maxWords',
        label: 'Max words',
        help: 'A whole number.',
        type: 'number',
        default: 8,
        min: 1,
        max: 32,
        integer: true,
      },
      {key: 'enabled', label: 'Enabled', help: 'A toggle.', type: 'boolean', default: true},
      {
        key: 'mode',
        label: 'Mode',
        help: 'One of a fixed set.',
        type: 'select',
        default: 'llm',
        options: [
          {value: 'llm', label: 'Model'},
          {value: 'off', label: 'Off'},
        ],
      },
    ],
  },
];

const [DEMO] = FIXTURE;

test('a field default satisfies the field it belongs to', () => {
  // A default that fails its own bounds would make `GET` answer with a value
  // `PATCH` refuses to accept. Both registries, so this stays honest as the real
  // one grows.
  for (const group of [...FIXTURE, ...SETTINGS_REGISTRY]) {
    for (const field of group.fields) {
      const parsed = settingsValueSchema(field).safeParse(field.default);
      assert.equal(parsed.success, true, `${group.slug}.${field.key} default is invalid`);
    }
  }
});

test('the served schema and the validating schema cannot drift apart', () => {
  // They are the same constant: `settingsGroupSchema` is derived from the very
  // fields the schema route serves. This asserts the derivation, so the day
  // someone hand-writes a zod object beside the registry, it fails here.
  for (const group of [...FIXTURE, ...SETTINGS_REGISTRY]) {
    assert.deepEqual(
      Object.keys(settingsGroupSchema(group).shape).sort(),
      group.fields.map(field => field.key).sort(),
    );
  }
});

test('the real registry keeps its slugs and its field keys unique', () => {
  // Field keys are a contract, and two groups sharing a slug would mean two
  // route registrations and one lost settings row.
  const slugs = SETTINGS_REGISTRY.map(group => group.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const group of SETTINGS_REGISTRY) {
    const keys = group.fields.map(field => field.key);
    assert.equal(new Set(keys).size, keys.length, `${group.slug} has a duplicate field key`);
  }
});

test('a patch accepts a subset and refuses a key the registry never declared', () => {
  const schema = settingsPatchSchema(DEMO);
  assert.equal(schema.safeParse({}).success, true);
  assert.equal(schema.safeParse({maxWords: 4}).success, true);

  const unknown = schema.safeParse({maxWords: 4, maxWorlds: 4});
  assert.equal(unknown.success, false);
  assert.match(unknown.error?.issues[0]?.message ?? '', /maxWorlds/);
});

test('a patch enforces the bounds the schema advertises', () => {
  const schema = settingsPatchSchema(DEMO);
  assert.equal(schema.safeParse({maxWords: 0}).success, false);
  assert.equal(schema.safeParse({maxWords: 33}).success, false);
  assert.equal(schema.safeParse({maxWords: 2.5}).success, false);
  assert.equal(schema.safeParse({mode: 'first-line'}).success, false);
  assert.equal(schema.safeParse({mode: 'off'}).success, true);
  assert.equal(schema.safeParse({prompt: 'x'.repeat(17)}).success, false);
  assert.equal(schema.safeParse({enabled: 'yes'}).success, false);
});

test('one unreadable field falls back alone, and takes no sibling with it', () => {
  const values = coerceSettingsValues(DEMO, {
    label: 'kept',
    maxWords: 999, // past `max`
    mode: 'nonsense', // not an option
    enabled: false,
  });
  assert.deepEqual(values, {
    label: 'kept',
    prompt: '',
    maxWords: 8,
    enabled: false,
    mode: 'llm',
  });

  // Nothing stored at all is every default, not an empty object.
  assert.deepEqual(coerceSettingsValues(DEMO, undefined), settingsGroupDefaults(DEMO));
  assert.deepEqual(coerceSettingsValues(DEMO, 'not an object'), settingsGroupDefaults(DEMO));
});

test('the repository reads defaults, merges a patch, and persists the whole group', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const settings = new SettingsRepository(database, FIXTURE);
    assert.deepEqual(settings.getGroup('demo'), settingsGroupDefaults(DEMO));

    // A patch of one field returns all of them, so a client never has to merge.
    assert.deepEqual(settings.updateGroup('demo', {maxWords: 4}), {
      label: 'hello',
      prompt: '',
      maxWords: 4,
      enabled: true,
      mode: 'llm',
    });
    // And a second repository over the same database sees it.
    assert.equal(new SettingsRepository(database, FIXTURE).getGroup('demo').maxWords, 4);
  } finally {
    database.close();
  }
});

test('a corrupt settings row answers with defaults instead of a 500', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    database.connection
      .prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('demo', '{not json', new Date().toISOString());
    assert.deepEqual(
      new SettingsRepository(database, FIXTURE).getGroup('demo'),
      settingsGroupDefaults(DEMO),
    );
  } finally {
    database.close();
  }
});

test('a key this build does not declare survives a write by one that does not know it', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    // Written by a newer server, or by this one before a field was renamed. It
    // cannot have come through `PATCH`, which is strict. Eating it here would
    // make the setting vanish the moment the user downgrades and saves.
    database.connection
      .prepare('INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)')
      .run(
        'demo',
        JSON.stringify({label: 'kept', maxWords: 999, fromTheFuture: 'keep me'}),
        new Date().toISOString(),
      );
    const settings = new SettingsRepository(database, FIXTURE);

    // The read never exposes it, and heals `maxWords` back to its default.
    assert.deepEqual(settings.getGroup('demo'), {...settingsGroupDefaults(DEMO), label: 'kept'});

    settings.updateGroup('demo', {enabled: false});
    const stored = JSON.parse(
      (
        database.connection
          .prepare('SELECT value_json FROM settings WHERE key = ?')
          .get('demo') as {
          value_json: string;
        }
      ).value_json,
    ) as Record<string, unknown>;
    assert.equal(stored.fromTheFuture, 'keep me', 'an undeclared key must survive the round trip');
    assert.equal(stored.label, 'kept');
    assert.equal(stored.enabled, false);
    assert.equal(stored.maxWords, 8, 'an out-of-bounds stored value is healed on write');
  } finally {
    database.close();
  }
});

test('the schema route serves the registry it was built with', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths, {settingsRegistry: FIXTURE});
  try {
    const response = await app.inject({method: 'GET', url: '/api/settings/schema'});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {sections: FIXTURE});
  } finally {
    await app.close();
  }
});

test('the real server serves the real registry, and a route for each of its groups', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({method: 'GET', url: '/api/settings/schema'});
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {sections: SETTINGS_REGISTRY});

    for (const group of SETTINGS_REGISTRY) {
      const values = await app.inject({method: 'GET', url: `/api/settings/${group.slug}`});
      assert.equal(values.statusCode, 200, `${group.slug} has no route`);
      assert.deepEqual(values.json(), settingsGroupDefaults(group));
    }

    // A group route exists only if its group does. An unknown `/api/*` path is a
    // 404 JSON with a coded error.
    const absent = await app.inject({method: 'PATCH', url: '/api/settings/demo'});
    assert.equal(absent.statusCode, 404);
    assert.equal(absent.json<{error: {code: string}}>().error.code, 'not_found');
    assert.match(absent.headers['content-type'] as string, /application\/json/);

    // **Nelle serves no web app, so there is no SPA to fall through to.** This used to assert
    // that a non-`/api` path answered `index.html`; now every unmatched path is the same coded
    // JSON 404, whatever its shape. Nelle is an API server, and every client is a native one.
    const appRoute = await app.inject({method: 'GET', url: '/some/app/route'});
    assert.equal(appRoute.statusCode, 404);
    assert.match(appRoute.headers['content-type'] as string, /application\/json/);
    assert.equal(appRoute.json<{error: {code: string}}>().error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('a group route round-trips through HTTP and rejects an undeclared key by name', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths, {settingsRegistry: FIXTURE});
  try {
    assert.deepEqual(
      (await app.inject({method: 'GET', url: '/api/settings/demo'})).json(),
      settingsGroupDefaults(DEMO),
    );

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/settings/demo',
      payload: {mode: 'off', maxWords: 12},
    });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json<{mode: string}>().mode, 'off');
    assert.equal(patched.json<{maxWords: number}>().maxWords, 12);
    // The write stuck, and the untouched fields came back at their defaults.
    assert.equal(patched.json<{label: string}>().label, 'hello');
    assert.equal(
      (await app.inject({method: 'GET', url: '/api/settings/demo'})).json<{
        mode: string;
      }>().mode,
      'off',
    );

    const rejected = await app.inject({
      method: 'PATCH',
      url: '/api/settings/demo',
      payload: {maxWorlds: 4},
    });
    assert.equal(rejected.statusCode, 400);
    const {error} = rejected.json<{error: {code: string; message: string}}>();
    assert.equal(error.code, 'invalid_request');
    assert.match(error.message, /maxWorlds/, 'a client must be told which key it got wrong');

    // A bad value is refused too, and nothing it touched was written.
    const outOfBounds = await app.inject({
      method: 'PATCH',
      url: '/api/settings/demo',
      payload: {maxWords: 99},
    });
    assert.equal(outOfBounds.statusCode, 400);
    assert.equal(
      (await app.inject({method: 'GET', url: '/api/settings/demo'})).json<{
        maxWords: number;
      }>().maxWords,
      12,
    );
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

test('the runtime limits are a settings group, and llama.cpp is launched from it', () => {
  // They lived in `state.json` behind `PATCH /api/runtime/settings`. They are two number
  // fields now, so whatever renders the schema renders them.
  const group = SETTINGS_REGISTRY.find(entry => entry.slug === RUNTIME_SETTINGS_SLUG);
  assert.ok(group, 'runtime must be a registry group');
  assert.deepEqual(
    group.fields.map(field => field.key),
    ['modelsMax', 'sleepIdleSeconds'],
  );

  // The default is 1 **on purpose**: a fresh install on a memory-constrained machine must
  // not try to hold two models. Multi-model use raises it; nothing else should.
  const modelsMax = group.fields[0]!;
  assert.equal(modelsMax.type === 'number' && modelsMax.default, 1);
  assert.equal(modelsMax.type === 'number' && modelsMax.min, 1);

  // Both take effect only when llama.cpp restarts, and the help text has to say so -- a
  // control that appears to do nothing is a bug report.
  for (const field of group.fields) {
    assert.match(field.help, /restart/i, `${field.key} must say it needs a restart`);
  }
});

test('the launch limits are read from the settings group, field by field', () => {
  assert.deepEqual(runtimeLimitsFromSettings({modelsMax: 4, sleepIdleSeconds: 30}), {
    modelsMax: 4,
    sleepIdleSeconds: 30,
  });

  // An empty group is a fresh install: llama.cpp holds one model and sleeps it after 90s.
  assert.deepEqual(runtimeLimitsFromSettings({}), {modelsMax: 1, sleepIdleSeconds: 90});

  // `0` sleep means never sleep, and must survive the read; `0` models does not exist.
  assert.equal(runtimeLimitsFromSettings({sleepIdleSeconds: 0}).sleepIdleSeconds, 0);
  assert.equal(runtimeLimitsFromSettings({modelsMax: 0}).modelsMax, 1);

  // One unreadable value falls back to its own default and takes no sibling with it.
  assert.deepEqual(runtimeLimitsFromSettings({modelsMax: 'two' as never, sleepIdleSeconds: 5}), {
    modelsMax: 1,
    sleepIdleSeconds: 5,
  });
});
