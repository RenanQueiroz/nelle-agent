import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {AppDatabase} from '../../../src/db/database.ts';
import {appendedSystemPrompts, nelleOperationalPrompt} from '../../../src/pi/harness.ts';
import {SettingsRepository} from '../../../src/settings/repository.ts';
import {createTestServer} from '../helpers/testServer.ts';
import type {AppPaths} from '../../../src/lib/paths.ts';
import {estimatePromptTokens} from '../../../src/contracts/piContext.ts';
import {
  MAX_CUSTOM_INSTRUCTIONS_CHARACTERS,
  SETTINGS_REGISTRY,
  findSettingsGroup,
} from '../../../src/contracts/settings.ts';
import {
  CUSTOM_INSTRUCTIONS_KEY,
  INSTRUCTIONS_SETTINGS_SLUG,
  SESSION_RESETTING_SETTINGS_SLUGS,
} from '../../../src/contracts/settingsKeys.ts';

test('the operational prompt states what host tools are, and survives the append', () => {
  // llama.cpp's web UI calls its equivalent "System Message" and lets it replace
  // the prompt. Nelle must not: this sentence is a safety statement.
  const enabled = nelleOperationalPrompt(true);
  assert.match(enabled, /You are Nelle Agent/);
  assert.match(enabled, /unsandboxed as the launching OS user/);

  const disabled = nelleOperationalPrompt(false);
  assert.match(disabled, /Host file and shell tools are disabled/);
  assert.match(disabled, /Do not claim that you can inspect files/);
  assert.doesNotMatch(disabled, /unsandboxed/);

  // The user's text is a separate string Pi appends, so nothing here can be
  // deleted by anything the user types.
  assert.deepEqual(appendedSystemPrompts('Answer in French.'), ['Answer in French.']);
});

test('empty instructions append nothing, not an empty string', () => {
  // `['']` would put a blank section into every prompt and cost a token to say
  // nothing at all.
  assert.deepEqual(appendedSystemPrompts(''), []);
  assert.deepEqual(appendedSystemPrompts('   \n  '), []);
  assert.deepEqual(appendedSystemPrompts('  keep me  '), ['keep me']);
});

test('the token cost is Pi arithmetic, not a round trip', () => {
  assert.equal(estimatePromptTokens(''), 0);
  assert.equal(estimatePromptTokens('abcd'), 1);
  assert.equal(estimatePromptTokens('abcde'), 2);
  // The cap exists because this is what it costs, on every prompt of every turn.
  assert.equal(estimatePromptTokens('x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARACTERS)), 2000);
});

test('saving the instructions is declared as a setting that rebuilds Pi sessions', () => {
  // Pi bakes the system prompt into a session at construction. A save that did
  // not reset them would reach an open conversation only after a restart.
  assert.ok(SESSION_RESETTING_SETTINGS_SLUGS.includes(INSTRUCTIONS_SETTINGS_SLUG));
  const group = findSettingsGroup(INSTRUCTIONS_SETTINGS_SLUG, SETTINGS_REGISTRY);
  assert.ok(group, 'the registry declares the group the route resets sessions for');
  assert.equal(group.fields[0]?.key, CUSTOM_INSTRUCTIONS_KEY);
});

test('the character cap is enforced by the server, not only by the textarea', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const tooLong = await app.inject({
      method: 'PATCH',
      url: `/api/settings/${INSTRUCTIONS_SETTINGS_SLUG}`,
      payload: {[CUSTOM_INSTRUCTIONS_KEY]: 'x'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARACTERS + 1)},
    });
    assert.equal(tooLong.statusCode, 400);
    assert.equal(tooLong.json<{error: {code: string}}>().error.code, 'invalid_request');
    assert.match(tooLong.json<{error: {message: string}}>().error.message, /8,000 characters/);

    // Exactly at the cap is fine, and it round-trips.
    const atCap = await app.inject({
      method: 'PATCH',
      url: `/api/settings/${INSTRUCTIONS_SETTINGS_SLUG}`,
      payload: {[CUSTOM_INSTRUCTIONS_KEY]: 'y'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARACTERS)},
    });
    assert.equal(atCap.statusCode, 200);
    const read = await app.inject({
      method: 'GET',
      url: `/api/settings/${INSTRUCTIONS_SETTINGS_SLUG}`,
    });
    assert.equal(
      (read.json<Record<string, string>>()[CUSTOM_INSTRUCTIONS_KEY] ?? '').length,
      MAX_CUSTOM_INSTRUCTIONS_CHARACTERS,
    );
  } finally {
    await app.close();
  }
});

test('the harness reads what the user saved, and nothing when they saved nothing', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const settings = new SettingsRepository(database);
    // Nothing saved: the default is an empty string, and it appends nothing.
    assert.deepEqual(
      appendedSystemPrompts(
        String(settings.getGroup(INSTRUCTIONS_SETTINGS_SLUG)[CUSTOM_INSTRUCTIONS_KEY]),
      ),
      [],
    );

    settings.updateGroup(INSTRUCTIONS_SETTINGS_SLUG, {
      [CUSTOM_INSTRUCTIONS_KEY]: 'Prefer short answers.',
    });
    assert.deepEqual(
      appendedSystemPrompts(
        String(settings.getGroup(INSTRUCTIONS_SETTINGS_SLUG)[CUSTOM_INSTRUCTIONS_KEY]),
      ),
      ['Prefer short answers.'],
    );
  } finally {
    database.close();
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
