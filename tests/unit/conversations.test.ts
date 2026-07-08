import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {ConversationRepository} from '../../apps/server/src/conversations.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createServer} from '../../apps/server/src/server.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {
  assertConversationTransition,
  canTransitionConversation,
} from '../../packages/shared/src/conversations.ts';

process.env.LOG_LEVEL = 'silent';

test('SQLite migration creates conversation tables and migration records', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const migration = database.connection
      .prepare('SELECT version, name FROM schema_migrations WHERE version = 1')
      .get() as {version: number; name: string} | undefined;
    const table = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get() as {name: string} | undefined;

    assert.equal(migration?.version, 1);
    assert.equal(migration?.name, 'initial_conversation_schema');
    assert.equal(table?.name, 'conversations');
  } finally {
    database.close();
  }
});

test('conversation state machine accepts planned transitions and rejects invalid ones', () => {
  assert.equal(canTransitionConversation('ready', 'running'), true);
  assert.equal(canTransitionConversation('running', 'aborting'), true);
  assert.equal(canTransitionConversation('unavailable', 'running'), false);
  assert.throws(
    () => assertConversationTransition('ready', 'aborting'),
    /Invalid conversation status transition/,
  );
});

test('repository mirrors current POC chat into a conversation snapshot', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    await store.addHuggingFaceModel({
      repoId: 'repo/model',
      quant: 'UD-Q4_K_M',
      name: 'Model Q4',
    });
    await store.appendChatMessage({
      id: 'user-1',
      role: 'user',
      content: 'Hello Nelle',
      createdAt: '2026-07-08T12:00:00.000Z',
    });
    await store.appendChatMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Hello back',
      createdAt: '2026-07-08T12:00:01.000Z',
    });

    const repository = new ConversationRepository(database);
    repository.syncPocConversationFromState(await store.getState());
    const snapshot = repository.getSnapshot('poc-default', await store.getState());

    assert.equal(snapshot?.conversation.id, 'poc-default');
    assert.deepEqual(snapshot?.activePathEntryIds, ['user-1', 'assistant-1']);
    assert.equal(snapshot?.entries[0]?.textPreview, 'Hello Nelle');
    assert.equal(snapshot?.models.available[0]?.id, 'repo/model:Q4_K_M');
    assert.equal(repository.listConversations({search: 'Hello'}).length, 1);
  } finally {
    database.close();
  }
});

test('repository stores Pi session bindings and replaces active branch projections', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Durable Pi chat'});
    repository.attachPiSession(conversation.id, {
      piSessionPath: path.join(paths.piSessionsDir, 'session.jsonl'),
      piSessionId: 'pi-session-1',
      activeLeafPiEntryId: 'entry-user',
    });
    repository.replaceConversationProjection(conversation.id, {
      piSessionPath: path.join(paths.piSessionsDir, 'session.jsonl'),
      piSessionId: 'pi-session-1',
      activeLeafPiEntryId: 'entry-assistant',
      lastSyncedPiEntryId: 'entry-assistant',
      entries: [
        {
          piEntryId: 'entry-user',
          entryType: 'message',
          role: 'user',
          text: 'Hello from Pi',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: 'entry-assistant',
          parentPiEntryId: 'entry-user',
          entryType: 'message',
          role: 'assistant',
          text: 'Hello from Nelle',
          createdAt: '2026-07-08T12:00:01.000Z',
          modelId: 'repo/model:Q4_K_M',
          modelRuntimeId: 'repo/model:Q4_K_M',
          modelAliasSnapshot: 'Model Q4',
        },
      ],
    });

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.equal(repository.getPiSessionBinding(conversation.id)?.piSessionId, 'pi-session-1');
    assert.equal(snapshot?.conversation.piSessionId, 'pi-session-1');
    assert.equal(snapshot?.conversation.activeLeafPiEntryId, 'entry-assistant');
    assert.deepEqual(snapshot?.activePathEntryIds, ['entry-user', 'entry-assistant']);
    assert.equal(snapshot?.entries[1]?.textPreview, 'Hello from Nelle');
    assert.equal(snapshot?.entries[1]?.modelAliasSnapshot, 'Model Q4');
  } finally {
    database.close();
  }
});

test('conversation API exposes list, snapshot, create, patch, pin, and delete routes', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.appendChatMessage({
    id: 'user-1',
    role: 'user',
    content: 'API seeded chat',
    createdAt: '2026-07-08T12:00:00.000Z',
  });

  const app = await createServer(paths);
  try {
    const listResponse = await app.inject({method: 'GET', url: '/api/conversations'});
    assert.equal(listResponse.statusCode, 200);
    const listed = listResponse.json<{
      conversations: Array<{id: string; title: string}>;
    }>();
    assert.equal(listed.conversations[0]?.id, 'poc-default');

    const snapshotResponse = await app.inject({
      method: 'GET',
      url: '/api/conversations/poc-default',
    });
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(
      snapshotResponse.json<{snapshot: {entries: unknown[]}}>().snapshot.entries.length,
      1,
    );

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {title: 'New durable chat'},
    });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json<{
      conversation: {id: string; title: string; pinned: boolean};
    }>().conversation;
    assert.equal(created.title, 'New durable chat');

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${created.id}`,
      payload: {title: 'Renamed chat'},
    });
    assert.equal(patchResponse.statusCode, 200);
    assert.equal(
      patchResponse.json<{conversation: {title: string}}>().conversation.title,
      'Renamed chat',
    );

    const pinResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.id}/pin`,
    });
    assert.equal(pinResponse.statusCode, 200);
    assert.equal(pinResponse.json<{conversation: {pinned: boolean}}>().conversation.pinned, true);

    const abortResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.id}/abort`,
    });
    assert.equal(abortResponse.statusCode, 200);
    const aborted = abortResponse.json<{
      ok: boolean;
      aborted: boolean;
      snapshot: {conversation: {id: string}};
    }>();
    assert.equal(aborted.ok, true);
    assert.equal(aborted.aborted, false);
    assert.equal(aborted.snapshot.conversation.id, created.id);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${created.id}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.deepEqual(deleteResponse.json(), {ok: true});
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
