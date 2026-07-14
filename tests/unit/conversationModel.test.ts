import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {resolveConversationModel} from '../../apps/server/src/conversations/model.ts';
import {ConversationRepository} from '../../apps/server/src/conversations/repository.ts';
import {AppDatabase} from '../../apps/server/src/db/database.ts';
import type {AppPaths} from '../../apps/server/src/lib/paths.ts';
import {AppStore} from '../../apps/server/src/models/store.ts';

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-convmodel-'));
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

async function setup() {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const modelA = await store.addHuggingFaceModel({
    repoId: 'repo/a',
    quant: 'UD-Q4_K_M',
    name: 'Model A',
  });
  const modelB = await store.addHuggingFaceModel({
    repoId: 'repo/b',
    quant: 'UD-Q4_K_M',
    name: 'Model B',
  });
  // A is the globally active model.
  await store.setActiveModel(modelA.id);

  const database = new AppDatabase(paths);
  await database.open();
  const conversations = new ConversationRepository(database);

  return {store, conversations, modelA, modelB};
}

test('a conversation runs on its own model, even while another is globally active', async () => {
  const {store, conversations, modelA, modelB} = await setup();

  conversations.createConversation({id: 'pinned', title: 'Pinned to B', defaultModelId: modelB.id});

  const resolved = await resolveConversationModel(conversations, store, 'pinned');

  // The whole point: a quick question elsewhere must not swap this chat's model.
  assert.equal(resolved?.id, modelB.id);
  assert.notEqual(resolved?.id, modelA.id);
});

test('an unpinned conversation still falls back to the globally active model', async () => {
  const {store, conversations, modelA} = await setup();

  conversations.createConversation({id: 'unpinned', title: 'No model'});

  assert.equal((await resolveConversationModel(conversations, store, 'unpinned'))?.id, modelA.id);
});

test('two conversations pinned to different models each keep their own', async () => {
  const {store, conversations, modelA, modelB} = await setup();

  conversations.createConversation({id: 'a', title: 'On A', defaultModelId: modelA.id});
  conversations.createConversation({id: 'b', title: 'On B', defaultModelId: modelB.id});

  assert.equal((await resolveConversationModel(conversations, store, 'a'))?.id, modelA.id);
  assert.equal((await resolveConversationModel(conversations, store, 'b'))?.id, modelB.id);
});

test('a conversation pinned to a removed model falls back instead of refusing to answer', async () => {
  const {store, conversations, modelA} = await setup();

  // The user deleted this model from models.ini after pinning the chat to it.
  conversations.createConversation({
    id: 'ghost',
    title: 'Pinned to a model that is gone',
    defaultModelId: 'repo/deleted:Q4_K_M',
  });

  // A chat that worked yesterday must not start refusing today.
  assert.equal((await resolveConversationModel(conversations, store, 'ghost'))?.id, modelA.id);
});

test('an unknown conversation falls back to the active model', async () => {
  const {store, conversations, modelA} = await setup();

  assert.equal((await resolveConversationModel(conversations, store, 'nope'))?.id, modelA.id);
});
