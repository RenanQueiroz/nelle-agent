import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';

import {SessionManager} from '@earendil-works/pi-coding-agent';
import {strFromU8, unzipSync} from 'fflate';

import {createAsyncQueue} from '../../apps/server/src/asyncQueue.ts';
import {ConversationRepository, POC_CONVERSATION_ID} from '../../apps/server/src/conversations.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import {HostToolRepository} from '../../apps/server/src/hostTools.ts';
import {PiHarness} from '../../apps/server/src/piHarness.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createServer} from '../../apps/server/src/server.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import type {ChatMessage, ChatStreamEvent, ConfiguredModel} from '../../apps/server/src/types.ts';
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
    const migrations = database.connection
      .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{version: number; name: string}>;
    const table = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get() as {name: string} | undefined;
    const contextColumn = database.connection
      .prepare("PRAGMA table_info('conversations')")
      .all()
      .some(column => (column as {name?: string}).name === 'context_usage_json');

    assert.deepEqual(
      migrations.map(migration => [migration.version, migration.name]),
      [
        [1, 'initial_conversation_schema'],
        [2, 'conversation_context_usage_cache'],
      ],
    );
    assert.equal(table?.name, 'conversations');
    assert.equal(contextColumn, true);
  } finally {
    database.close();
  }
});

test('SQLite migration backs up existing databases before repairing migration records', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  database.close();

  const raw = new DatabaseSync(paths.settingsDbPath);
  try {
    raw.exec('DELETE FROM schema_migrations WHERE version = 2;');
  } finally {
    raw.close();
  }

  await fs.rm(path.join(paths.dataDir, 'backups'), {recursive: true, force: true});
  const repaired = new AppDatabase(paths);
  await repaired.open();
  try {
    const migrations = repaired.connection
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{version: number}>;
    assert.deepEqual(
      migrations.map(migration => migration.version),
      [1, 2],
    );
  } finally {
    repaired.close();
  }

  const backupDir = path.join(paths.dataDir, 'backups');
  const backupFiles = await fs.readdir(backupDir);
  assert.equal(backupFiles.length, 1);
  const backup = new DatabaseSync(path.join(backupDir, backupFiles[0]!));
  try {
    const backupMigrations = backup
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{version: number}>;
    const contextColumn = backup
      .prepare("PRAGMA table_info('conversations')")
      .all()
      .some(column => (column as {name?: string}).name === 'context_usage_json');

    assert.deepEqual(
      backupMigrations.map(migration => migration.version),
      [1],
    );
    assert.equal(contextColumn, true);
  } finally {
    backup.close();
  }
});

test('conversation state machine accepts planned transitions and rejects invalid ones', () => {
  assert.equal(canTransitionConversation('ready', 'running'), true);
  assert.equal(canTransitionConversation('running', 'aborting'), true);
  assert.equal(canTransitionConversation('unavailable', 'running'), false);
  assert.throws(
    () => assertConversationTransition('ready', 'aborting'),
    error => {
      assert.match(String((error as Error).message), /Invalid conversation status transition/);
      assert.equal((error as {code?: string}).code, 'invalid_conversation_transition');
      assert.equal((error as {retryable?: boolean}).retryable, false);
      return true;
    },
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

test('repository does not overwrite Pi-bound POC projection from legacy state', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    await store.appendChatMessage({
      id: 'legacy-user',
      role: 'user',
      content: 'Legacy state prompt',
      createdAt: '2026-07-08T12:00:00.000Z',
    });
    const repository = new ConversationRepository(database);
    repository.createConversation({id: POC_CONVERSATION_ID, title: 'Pi default'});
    repository.attachPiSession(POC_CONVERSATION_ID, {
      piSessionPath: path.join(paths.piSessionsDir, 'poc.jsonl'),
      piSessionId: 'pi-poc',
      activeLeafPiEntryId: 'pi-user',
    });
    repository.replaceConversationProjection(POC_CONVERSATION_ID, {
      piSessionPath: path.join(paths.piSessionsDir, 'poc.jsonl'),
      piSessionId: 'pi-poc',
      activeLeafPiEntryId: 'pi-user',
      lastSyncedPiEntryId: 'pi-user',
      entries: [
        {
          piEntryId: 'pi-user',
          entryType: 'message',
          role: 'user',
          text: 'Pi prompt',
          createdAt: '2026-07-08T12:00:01.000Z',
        },
      ],
    });

    repository.syncPocConversationFromState(await store.getState());
    const snapshot = repository.getSnapshot(POC_CONVERSATION_ID, await store.getState());

    assert.equal(snapshot?.conversation.piSessionId, 'pi-poc');
    assert.equal(snapshot?.entries[0]?.piEntryId, 'pi-user');
    assert.equal(snapshot?.entries[0]?.textPreview, 'Pi prompt');
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
          performance: {
            generation: {tokens: 3, tokensPerSecond: 12},
          },
        },
      ],
    });
    repository.replaceConversationProjection(conversation.id, {
      piSessionPath: path.join(paths.piSessionsDir, 'session.jsonl'),
      piSessionId: 'pi-session-1',
      activeLeafPiEntryId: 'entry-compaction',
      lastSyncedPiEntryId: 'entry-compaction',
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
        {
          piEntryId: 'entry-compaction',
          parentPiEntryId: 'entry-assistant',
          entryType: 'compaction',
          text: 'Earlier context summary',
          createdAt: '2026-07-08T12:00:02.000Z',
        },
      ],
    });

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.equal(repository.getPiSessionBinding(conversation.id)?.piSessionId, 'pi-session-1');
    assert.equal(snapshot?.conversation.piSessionId, 'pi-session-1');
    assert.equal(snapshot?.conversation.activeLeafPiEntryId, 'entry-compaction');
    assert.deepEqual(snapshot?.activePathEntryIds, [
      'entry-user',
      'entry-assistant',
      'entry-compaction',
    ]);
    assert.equal(snapshot?.entries[1]?.textPreview, 'Hello from Nelle');
    assert.equal(snapshot?.entries[1]?.modelAliasSnapshot, 'Model Q4');
    assert.deepEqual(snapshot?.entries[1]?.performance, {
      generation: {tokens: 3, tokensPerSecond: 12},
    });
    assert.equal(snapshot?.entries[2]?.entryType, 'compaction');

    const source = repository.getRegenerationSource(conversation.id, 'entry-assistant');
    assert.equal(source?.userEntry.piEntryId, 'entry-user');
    assert.equal(source?.branchFromPiEntryId, null);
    assert.equal(source?.regeneratesPiEntryId, 'entry-assistant');
    assert.equal(source?.displayGroupId, 'entry-assistant');
  } finally {
    database.close();
  }
});

test('repository marks missing or corrupt Pi session files unavailable', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const missingConversation = repository.createConversation({title: 'Missing session'});
    const sessionManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    const userEntryId = sessionManager.appendMessage({
      role: 'user',
      content: 'This session file will disappear',
    } as any);
    const sessionPath = sessionManager.getSessionFile();
    assert.ok(sessionPath);
    repository.attachPiSession(missingConversation.id, {
      piSessionPath: sessionPath,
      piSessionId: sessionManager.getSessionId(),
      activeLeafPiEntryId: userEntryId,
    });
    await fs.rm(sessionPath, {force: true});

    const missing = await repository.markUnavailableIfPiSessionInvalid(missingConversation.id);
    const missingSnapshot = repository.getSnapshot(missingConversation.id, await store.getState());

    assert.equal(missing?.status, 'unavailable');
    assert.equal(missingSnapshot?.conversation.status, 'unavailable');
    assert.equal(missingSnapshot?.capabilities.canSend, false);
    assert.equal(missingSnapshot?.capabilities.canFork, false);
    assert.equal(missingSnapshot?.errors[0]?.code, 'session_unavailable');

    const corruptConversation = repository.createConversation({title: 'Corrupt session'});
    const corruptPath = path.join(paths.piSessionsDir, 'corrupt.jsonl');
    await fs.mkdir(path.dirname(corruptPath), {recursive: true});
    await fs.writeFile(corruptPath, 'not-json\n');
    repository.attachPiSession(corruptConversation.id, {
      piSessionPath: corruptPath,
      piSessionId: 'corrupt-session',
    });

    const changed = await repository.markInvalidPiSessionsUnavailable();
    const corruptSnapshot = repository.getSnapshot(corruptConversation.id, await store.getState());

    assert.equal(changed, 1);
    assert.equal(corruptSnapshot?.conversation.status, 'unavailable');
    assert.equal(
      repository
        .listConversations({search: 'Corrupt'})
        .find(conversation => conversation.id === corruptConversation.id)?.status,
      'unavailable',
    );
  } finally {
    database.close();
  }
});

test('repository applies generated titles without overwriting user titles', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const generated = repository.createConversation({title: 'New chat'});
    const updated = repository.setGeneratedTitle(generated.id, 'Local Model Setup');

    assert.equal(updated?.title, 'Local Model Setup');
    assert.equal(updated?.titleSource, 'generated');
    assert.equal(repository.getTitleSource(generated.id), 'generated');

    const userNamed = repository.createConversation({title: 'Pinned name', titleSource: 'user'});
    assert.equal(repository.setGeneratedTitle(userNamed.id, 'Ignored title'), null);
    assert.equal(
      repository.getSnapshot(userNamed.id, await new AppStore(paths).getState())?.conversation
        .title,
      'Pinned name',
    );
  } finally {
    database.close();
  }
});

test('repository derives context usage from assistant performance metadata', async () => {
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
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Context chat'});

    repository.replaceConversationProjection(conversation.id, {
      activeLeafPiEntryId: 'assistant-1',
      lastSyncedPiEntryId: 'assistant-1',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Use context',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: 'assistant-1',
          parentPiEntryId: 'user-1',
          entryType: 'message',
          role: 'assistant',
          text: 'Context used.',
          createdAt: '2026-07-08T12:00:01.000Z',
          performance: {
            source: 'llamacpp-timings',
            prompt: {
              tokens: 100,
              totalTokens: 128,
              tokensPerSecond: 40,
            },
            generation: {
              tokens: 6,
              tokensPerSecond: 20,
            },
          },
        },
      ],
    });

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.deepEqual(snapshot?.context, {
      usedTokens: 134,
      totalTokens: 8192,
      source: 'timings',
      updatedAt: '2026-07-08T12:00:01.000Z',
    });
  } finally {
    database.close();
  }
});

test('repository persists and binds message attachments to Pi entries', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Attachment chat'});
    repository.replaceConversationProjection(conversation.id, {
      activeLeafPiEntryId: 'assistant-1',
      lastSyncedPiEntryId: 'assistant-1',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Summarize the file',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: 'assistant-1',
          parentPiEntryId: 'user-1',
          entryType: 'message',
          role: 'assistant',
          text: 'The file describes local setup.',
          createdAt: '2026-07-08T12:00:01.000Z',
        },
      ],
    });

    const pending = repository.createPendingAttachments(conversation.id, [
      {
        uploadId: 'draft-1',
        kind: 'text',
        name: 'notes.md',
        mimeType: 'text/markdown',
        sizeBytes: 28,
        textContent: 'Nelle uses llama.cpp locally.',
        processing: {status: 'ready'},
      },
    ]);
    assert.equal(pending[0]?.piEntryId, undefined);

    const bound = repository.bindAttachmentsToEntry(conversation.id, ['draft-1'], 'user-1');
    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.equal(bound.length, 1);
    assert.equal(snapshot?.attachments[0]?.piEntryId, 'user-1');
    assert.equal(snapshot?.attachments[0]?.uploadId, 'draft-1');
    assert.equal(snapshot?.attachments[0]?.textPreview, 'Nelle uses llama.cpp locally.');
    assert.deepEqual(snapshot?.entries[0]?.attachmentSummary, {
      count: 1,
      items: [
        {
          id: snapshot.attachments[0]?.id,
          kind: 'text',
          name: 'notes.md',
          mimeType: 'text/markdown',
          sizeBytes: 28,
        },
      ],
    });
  } finally {
    database.close();
  }
});

test('repository stores fork metadata and copies attachment summaries between conversations', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const source = repository.createConversation({title: 'Source chat'});
    repository.replaceConversationProjection(source.id, {
      activeLeafPiEntryId: 'user-1',
      lastSyncedPiEntryId: 'user-1',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Read the attached plan',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
      ],
    });
    repository.createPendingAttachments(source.id, [
      {
        uploadId: 'draft-1',
        kind: 'text',
        name: 'plan.md',
        mimeType: 'text/markdown',
        sizeBytes: 18,
        textContent: 'Implementation plan',
        processing: {status: 'ready'},
      },
    ]);
    repository.bindAttachmentsToEntry(source.id, ['draft-1'], 'user-1');

    const target = repository.createConversation({
      title: 'Source chat (fork)',
      parentConversationId: source.id,
      forkedFromPiEntryId: 'user-1',
      forkKind: 'fork',
    });
    repository.replaceConversationProjection(target.id, {
      activeLeafPiEntryId: 'user-1',
      lastSyncedPiEntryId: 'user-1',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Read the attached plan',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
      ],
    });

    const copied = repository.copyAttachmentsForEntries(source.id, target.id, ['user-1']);
    const snapshot = repository.getSnapshot(target.id, await store.getState());

    assert.equal(snapshot?.conversation.parentConversationId, source.id);
    assert.equal(snapshot?.conversation.forkedFromPiEntryId, 'user-1');
    assert.equal(snapshot?.conversation.forkKind, 'fork');
    assert.equal(copied.length, 1);
    assert.equal(snapshot?.attachments[0]?.conversationId, target.id);
    assert.equal(snapshot?.attachments[0]?.piEntryId, 'user-1');
    assert.equal(snapshot?.attachments[0]?.textPreview, 'Implementation plan');
    assert.deepEqual(snapshot?.entries[0]?.attachmentSummary, {
      count: 1,
      items: [
        {
          id: snapshot.attachments[0]?.id,
          kind: 'text',
          name: 'plan.md',
          mimeType: 'text/markdown',
          sizeBytes: 18,
        },
      ],
    });
  } finally {
    database.close();
  }
});

test('Pi fork from a user entry creates a durable new session file', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const source = repository.createConversation({title: 'Source chat'});
    const sourceManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    const userEntryId = sourceManager.appendMessage({
      role: 'user',
      content: 'Fork from this prompt',
    } as any);
    const assistantEntryId = sourceManager.appendMessage({
      role: 'assistant',
      content: 'Existing answer',
    } as any);
    const sourceSessionPath = sourceManager.getSessionFile();
    assert.ok(sourceSessionPath);
    repository.attachPiSession(source.id, {
      piSessionPath: sourceSessionPath,
      piSessionId: sourceManager.getSessionId(),
      activeLeafPiEntryId: assistantEntryId,
    });
    repository.replaceConversationProjection(source.id, {
      piSessionPath: sourceSessionPath,
      piSessionId: sourceManager.getSessionId(),
      activeLeafPiEntryId: assistantEntryId,
      lastSyncedPiEntryId: assistantEntryId,
      entries: [
        {
          piEntryId: userEntryId,
          entryType: 'message',
          role: 'user',
          text: 'Fork from this prompt',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: assistantEntryId,
          parentPiEntryId: userEntryId,
          entryType: 'message',
          role: 'assistant',
          text: 'Existing answer',
          createdAt: '2026-07-08T12:00:01.000Z',
          modelId: 'repo/model:Q4_K_M',
          modelRuntimeId: 'repo/model:Q4_K_M',
          modelAliasSnapshot: 'Model Q4',
        },
      ],
    });

    const harness = new PiHarness(paths, store, repository, new HostToolRepository(database));
    const forked = await harness.forkConversation({
      conversationId: source.id,
      entryId: userEntryId,
    });
    const binding = repository.getPiSessionBinding(forked.conversation.id);

    assert.equal(forked.conversation.parentConversationId, source.id);
    assert.equal(forked.conversation.forkedFromPiEntryId, userEntryId);
    assert.equal(forked.conversation.forkKind, 'fork');
    assert.equal(forked.entries.length, 1);
    assert.equal(forked.entries[0]?.piEntryId, userEntryId);
    assert.ok(binding?.piSessionPath);
    await fs.access(binding.piSessionPath);
    assert.deepEqual(
      repository.getConversationEntries(source.id).map(entry => entry.piEntryId),
      [userEntryId, assistantEntryId],
    );
  } finally {
    database.close();
  }
});

test('Pi harness does not recreate a missing bound session file', async () => {
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

    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Missing session'});
    const sessionManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    const userEntryId = sessionManager.appendMessage({
      role: 'user',
      content: 'Original prompt',
    } as any);
    const sessionPath = sessionManager.getSessionFile();
    assert.ok(sessionPath);
    repository.attachPiSession(conversation.id, {
      piSessionPath: sessionPath,
      piSessionId: sessionManager.getSessionId(),
      activeLeafPiEntryId: userEntryId,
    });
    await fs.rm(sessionPath, {force: true});

    const harness = new PiHarness(paths, store, repository, new HostToolRepository(database));

    await assert.rejects(
      () => harness.streamPrompt('Do not create a replacement session', conversation.id),
      /conversation session is unavailable/i,
    );
    assert.equal(repository.getConversation(conversation.id)?.status, 'unavailable');
    assert.deepEqual(await fs.readdir(paths.piSessionsDir), []);
  } finally {
    database.close();
  }
});

test('conversation delete removes owned session files and unreferenced attachments', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const privateAttachmentPath = path.join(paths.attachmentsDir, 'aa', 'private.bin');
  const sharedAttachmentPath = path.join(paths.attachmentsDir, 'bb', 'shared.bin');
  const sessionPath = path.join(paths.piSessionsDir, 'delete-me.jsonl');
  let targetId = '';
  let keeperId = '';
  try {
    await fs.mkdir(path.dirname(privateAttachmentPath), {recursive: true});
    await fs.mkdir(path.dirname(sharedAttachmentPath), {recursive: true});
    await fs.mkdir(paths.piSessionsDir, {recursive: true});
    await fs.writeFile(privateAttachmentPath, 'private attachment');
    await fs.writeFile(sharedAttachmentPath, 'shared attachment');
    await fs.writeFile(sessionPath, '{"type":"session","id":"delete-me"}\n');

    const repository = new ConversationRepository(database);
    const target = repository.createConversation({title: 'Delete target'});
    const keeper = repository.createConversation({title: 'Keep shared file'});
    targetId = target.id;
    keeperId = keeper.id;
    repository.attachPiSession(target.id, {
      piSessionPath: sessionPath,
      piSessionId: 'delete-me',
      activeLeafPiEntryId: 'user-1',
    });
    for (const conversationId of [target.id, keeper.id]) {
      repository.replaceConversationProjection(conversationId, {
        activeLeafPiEntryId: 'user-1',
        lastSyncedPiEntryId: 'user-1',
        entries: [
          {
            piEntryId: 'user-1',
            entryType: 'message',
            role: 'user',
            text: 'Attached',
            createdAt: '2026-07-08T12:00:00.000Z',
          },
        ],
      });
    }
    repository.createPendingAttachments(target.id, [
      {
        uploadId: 'private',
        kind: 'image',
        name: 'private.bin',
        storagePath: 'attachments/aa/private.bin',
        processing: {status: 'ready'},
      },
      {
        uploadId: 'shared-target',
        kind: 'image',
        name: 'shared.bin',
        storagePath: 'attachments/bb/shared.bin',
        processing: {status: 'ready'},
      },
    ]);
    repository.bindAttachmentsToEntry(target.id, ['private', 'shared-target'], 'user-1');
    repository.createPendingAttachments(keeper.id, [
      {
        uploadId: 'shared-keeper',
        kind: 'image',
        name: 'shared.bin',
        storagePath: 'attachments/bb/shared.bin',
        processing: {status: 'ready'},
      },
    ]);
    repository.bindAttachmentsToEntry(keeper.id, ['shared-keeper'], 'user-1');
  } finally {
    database.close();
  }

  const app = await createServer(paths);
  try {
    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${targetId}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json<{cleanup: {deleted: number}}>().cleanup.deleted, 2);
    await assert.rejects(() => fs.access(sessionPath), {code: 'ENOENT'});
    await assert.rejects(() => fs.access(privateAttachmentPath), {code: 'ENOENT'});
    await fs.access(sharedAttachmentPath);
    const keeperResponse = await app.inject({
      method: 'GET',
      url: `/api/conversations/${keeperId}`,
    });
    assert.equal(keeperResponse.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('server startup sweeps orphan attachment files and preserves referenced files', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const orphanAttachmentPath = path.join(paths.attachmentsDir, 'or', 'orphan.bin');
  const referencedAttachmentPath = path.join(paths.attachmentsDir, 'dd', 'referenced.bin');
  try {
    await fs.mkdir(path.dirname(orphanAttachmentPath), {recursive: true});
    await fs.mkdir(path.dirname(referencedAttachmentPath), {recursive: true});
    await fs.writeFile(orphanAttachmentPath, 'orphan attachment');
    await fs.writeFile(referencedAttachmentPath, 'referenced attachment');

    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Referenced attachment'});
    repository.createPendingAttachments(conversation.id, [
      {
        uploadId: 'referenced',
        kind: 'image',
        name: 'referenced.bin',
        storagePath: 'attachments/dd/referenced.bin',
        processing: {status: 'ready'},
      },
    ]);
  } finally {
    database.close();
  }

  const app = await createServer(paths);
  try {
    await assert.rejects(() => fs.access(orphanAttachmentPath), {code: 'ENOENT'});
    await assert.rejects(() => fs.access(path.dirname(orphanAttachmentPath)), {code: 'ENOENT'});
    await fs.access(referencedAttachmentPath);
  } finally {
    await app.close();
  }
});

test('conversation export and import round trip Pi history and attachments', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const attachmentPath = path.join(paths.attachmentsDir, 'cc', 'export.bin');
  let sourceId = '';
  try {
    await fs.mkdir(path.dirname(attachmentPath), {recursive: true});
    await fs.writeFile(attachmentPath, 'archive attachment');

    const repository = new ConversationRepository(database);
    const source = repository.createConversation({title: 'Archive source'});
    sourceId = source.id;
    const sourceManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    const userEntryId = sourceManager.appendMessage({
      role: 'user',
      content: 'Export this chat',
    } as any);
    const assistantEntryId = sourceManager.appendMessage({
      role: 'assistant',
      content: 'Archive ready.',
    } as any);
    const sourceSessionPath = sourceManager.getSessionFile();
    assert.ok(sourceSessionPath);
    repository.attachPiSession(source.id, {
      piSessionPath: sourceSessionPath,
      piSessionId: sourceManager.getSessionId(),
      activeLeafPiEntryId: assistantEntryId,
    });
    repository.replaceConversationProjection(source.id, {
      piSessionPath: sourceSessionPath,
      piSessionId: sourceManager.getSessionId(),
      activeLeafPiEntryId: assistantEntryId,
      lastSyncedPiEntryId: assistantEntryId,
      entries: [
        {
          piEntryId: userEntryId,
          entryType: 'message',
          role: 'user',
          text: 'Export this chat',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: assistantEntryId,
          parentPiEntryId: userEntryId,
          entryType: 'message',
          role: 'assistant',
          text: 'Archive ready.',
          createdAt: '2026-07-08T12:00:01.000Z',
          modelId: 'repo/model:Q4_K_M',
          modelRuntimeId: 'repo/model:Q4_K_M',
          modelAliasSnapshot: 'Model Q4',
        },
      ],
    });
    repository.createPendingAttachments(source.id, [
      {
        uploadId: 'archive-attachment',
        kind: 'image',
        name: 'export.bin',
        storagePath: 'attachments/cc/export.bin',
        processing: {status: 'ready'},
      },
    ]);
    repository.bindAttachmentsToEntry(source.id, ['archive-attachment'], userEntryId);
    const hostTools = new HostToolRepository(database);
    hostTools.recordToolStart({
      conversationId: source.id,
      piToolCallId: 'tool-1',
      toolName: 'bash',
      args: {command: 'pwd'},
      startedAt: new Date('2026-07-08T12:00:02.000Z'),
    });
    hostTools.recordToolEnd({
      conversationId: source.id,
      piToolCallId: 'tool-1',
      toolName: 'bash',
      args: {command: 'pwd'},
      status: 'complete',
      output: {stdout: '/home/renan/nelle-server'},
      completedAt: new Date('2026-07-08T12:00:03.000Z'),
      durationMs: 1000,
    });
  } finally {
    database.close();
  }

  const app = await createServer(paths);
  try {
    const exportResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${sourceId}/export`,
    });
    assert.equal(exportResponse.statusCode, 200);
    assert.match(exportResponse.headers['content-type'] as string, /application\/zip/);
    const archiveBytes = exportResponse.rawPayload;
    const archive = unzipSync(new Uint8Array(archiveBytes));
    assert.ok(archive['manifest.json']);
    assert.ok(archive['pi-session.jsonl']);
    assert.ok(archive['nelle-conversation.json']);
    assert.ok(archive['tool-audit.jsonl']);
    const manifest = JSON.parse(strFromU8(archive['manifest.json']!)) as {
      conversation: {id: string; title: string};
      source: {platform: string};
    };
    assert.deepEqual(manifest.conversation, {id: sourceId, title: 'Archive source'});
    assert.equal(manifest.source.platform, process.platform);
    assert.equal(strFromU8(archive['attachments/cc/export.bin']!), 'archive attachment');
    const auditLine = strFromU8(archive['tool-audit.jsonl']!).trim();
    const audit = JSON.parse(auditLine) as {
      conversationId: string;
      piToolCallId: string;
      toolName: string;
      status: string;
      input: {command: string};
      output: {stdout: string};
    };
    assert.equal(audit.conversationId, sourceId);
    assert.equal(audit.piToolCallId, 'tool-1');
    assert.equal(audit.toolName, 'bash');
    assert.equal(audit.status, 'complete');
    assert.deepEqual(audit.input, {command: 'pwd'});
    assert.deepEqual(audit.output, {stdout: '/home/renan/nelle-server'});

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${sourceId}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    await assert.rejects(() => fs.access(attachmentPath), {code: 'ENOENT'});

    const importResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations/import',
      headers: {'content-type': 'application/zip'},
      payload: Buffer.from(archiveBytes),
    });
    assert.equal(importResponse.statusCode, 200);
    const imported = importResponse.json<{
      snapshot: {
        conversation: {id: string; title: string; titleSource: string};
        entries: Array<{piEntryId: string; textPreview?: string; modelAliasSnapshot?: string}>;
        attachments: Array<{piEntryId?: string; storagePath?: string; name: string}>;
      };
    }>().snapshot;

    assert.notEqual(imported.conversation.id, sourceId);
    assert.equal(imported.conversation.title, 'Archive source (import)');
    assert.equal(imported.conversation.titleSource, 'imported');
    assert.deepEqual(
      imported.entries.map(entry => entry.textPreview),
      ['Export this chat', 'Archive ready.'],
    );
    assert.equal(imported.entries[1]?.modelAliasSnapshot, 'Model Q4');
    assert.equal(imported.attachments[0]?.name, 'export.bin');
    assert.equal(imported.attachments[0]?.storagePath, 'attachments/cc/export.bin');
    await fs.access(attachmentPath);

    const duplicateArchiveResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations/import',
      headers: {'content-type': 'application/zip'},
      payload: Buffer.from(duplicateZipEntry(new Uint8Array(archiveBytes), 'manifest.json')),
    });
    assert.equal(duplicateArchiveResponse.statusCode, 400);
    assert.match(duplicateArchiveResponse.json().error.message, /duplicate file entry/);
  } finally {
    await app.close();
  }
});

function duplicateZipEntry(bytes: Uint8Array, filename: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findZipEocd(view);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
  let offset = centralDirectoryOffset;
  let duplicate: Uint8Array | null = null;
  const decoder = new TextDecoder();
  for (let index = 0; index < entryCount; index += 1) {
    const filenameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const filenameStart = offset + 46;
    const filenameEnd = filenameStart + filenameLength;
    const recordEnd = filenameEnd + extraLength + commentLength;
    if (decoder.decode(bytes.subarray(filenameStart, filenameEnd)) === filename) {
      duplicate = bytes.slice(offset, recordEnd);
      break;
    }
    offset = recordEnd;
  }
  assert.ok(duplicate);

  const beforeEocd = bytes.subarray(0, eocdOffset);
  const eocd = bytes.slice(eocdOffset);
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);
  eocdView.setUint16(8, entryCount + 1, true);
  eocdView.setUint16(10, entryCount + 1, true);
  eocdView.setUint32(12, centralDirectorySize + duplicate.byteLength, true);

  const mutated = new Uint8Array(beforeEocd.byteLength + duplicate.byteLength + eocd.byteLength);
  mutated.set(beforeEocd, 0);
  mutated.set(duplicate, beforeEocd.byteLength);
  mutated.set(eocd, beforeEocd.byteLength + duplicate.byteLength);
  return mutated;
}

function findZipEocd(view: DataView): number {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error('No zip central directory found.');
}

test('Pi title generation stores sanitized first-turn title without adding history', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({choices: [{message: {content: '"Local Model Setup!"'}}]}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }) as typeof fetch;
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'New chat'});
    const activeModel = createTestModel();
    const entries = createFirstTurnEntries();
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as TitleGenerationHarness;

    const title = await harness.maybeGenerateConversationTitle(
      conversation.id,
      activeModel,
      entries,
    );
    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.equal(title, 'Local Model Setup');
    assert.equal(snapshot?.conversation.title, 'Local Model Setup');
    assert.equal(snapshot?.conversation.titleSource, 'generated');
    assert.deepEqual(repository.getConversationEntries(conversation.id), []);
    assert.deepEqual((await store.getState()).chat, []);
    assert.equal(requests.length, 1);
    const request = requests[0] as {messages?: Array<{role: string; content: string}>};
    assert.equal(request.messages?.[0]?.role, 'system');
    assert.match(request.messages?.[1]?.content ?? '', /User: Explain local setup/);
    assert.match(request.messages?.[1]?.content ?? '', /Assistant: Use llama.cpp locally/);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('Pi title generation emits title run lifecycle events', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({choices: [{message: {content: 'Local Model Setup'}}]}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    })) as typeof fetch;
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'New chat'});
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as TitleGenerationHarness;
    const queue = createAsyncQueue<ChatStreamEvent>();
    const eventsPromise = collectAsyncQueue(queue);

    await harness.streamConversationTitleIfNeeded(
      conversation.id,
      createTestModel(),
      createFirstTurnEntries(),
      queue,
    );
    queue.end();
    const events = await eventsPromise;
    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.deepEqual(
      events.map(event => event.type),
      ['run.started', 'conversation_title', 'run.completed'],
    );
    assert.equal(events[0]?.type, 'run.started');
    assert.equal(events[0]?.kind, 'title');
    assert.equal(events[1]?.type, 'conversation_title');
    assert.equal(events[1]?.title, 'Local Model Setup');
    assert.equal(events[2]?.type, 'run.completed');
    assert.equal(events[2]?.status, 'completed');
    assert.equal(snapshot?.conversation.title, 'Local Model Setup');
    assert.equal(snapshot?.conversation.titleSource, 'generated');
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('Pi title generation abort emits aborted run lifecycle events', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        },
        {once: true},
      );
    });
  }) as typeof fetch;
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'New chat'});
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as TitleGenerationHarness;
    const queue = createAsyncQueue<ChatStreamEvent>();
    const iterator = queue[Symbol.asyncIterator]();
    const events: ChatStreamEvent[] = [];

    const titlePromise = harness.streamConversationTitleIfNeeded(
      conversation.id,
      createTestModel(),
      createFirstTurnEntries(),
      queue,
    );
    const first = await iterator.next();
    assert.equal(first.done, false);
    events.push(first.value);
    assert.equal(first.value.type, 'run.started');
    assert.equal(first.value.kind, 'title');

    const abortResult = await harness.abortConversationRun(conversation.id, first.value.runId);
    assert.equal(abortResult.aborted, true);
    await titlePromise;
    queue.end();
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      events.push(next.value);
    }

    assert.deepEqual(
      events.map(event => event.type),
      ['run.started', 'run.aborted', 'run.completed'],
    );
    assert.equal(events[1]?.type, 'run.aborted');
    assert.equal(events[2]?.type, 'run.completed');
    assert.equal(events[2]?.status, 'aborted');
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('Pi title generation falls back quietly when llama title request fails', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('upstream unavailable', {status: 502})) as typeof fetch;
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'New chat'});
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as TitleGenerationHarness;

    const title = await harness.maybeGenerateConversationTitle(
      conversation.id,
      createTestModel(),
      createFirstTurnEntries(),
    );
    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.equal(title, null);
    assert.equal(snapshot?.conversation.title, 'New chat');
    assert.equal(snapshot?.conversation.titleSource, 'fallback');
    assert.deepEqual(repository.getConversationEntries(conversation.id), []);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('Pi title generation skips non-first-turn and user-named conversations', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({choices: [{message: {content: 'Should Not Use'}}]}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }) as typeof fetch;
  try {
    const repository = new ConversationRepository(database);
    const userNamed = repository.createConversation({title: 'Pinned name', titleSource: 'user'});
    const fallback = repository.createConversation({title: 'New chat'});
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as TitleGenerationHarness;

    const userNamedTitle = await harness.maybeGenerateConversationTitle(
      userNamed.id,
      createTestModel(),
      createFirstTurnEntries(),
    );
    const multiTurnTitle = await harness.maybeGenerateConversationTitle(
      fallback.id,
      createTestModel(),
      [
        ...createFirstTurnEntries(),
        {
          piEntryId: 'user-2',
          entryType: 'message',
          role: 'user',
          text: 'Follow up',
          createdAt: '2026-07-08T12:02:00.000Z',
        },
      ],
    );

    assert.equal(userNamedTitle, null);
    assert.equal(multiTurnTitle, null);
    assert.equal(fetchCalls, 0);
    assert.equal(
      repository.getSnapshot(userNamed.id, await store.getState())?.conversation.title,
      'Pinned name',
    );
    assert.equal(
      repository.getSnapshot(fallback.id, await store.getState())?.conversation.title,
      'New chat',
    );
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});

test('Pi compact stream emits run and compaction lifecycle events', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Compact me'});
    let compactInstructions: string | undefined;
    const branch = [
      {
        id: 'user-1',
        parentId: null,
        type: 'message',
        message: {role: 'user', content: 'Summarize the repo setup.'},
        timestamp: '2026-07-08T12:00:00.000Z',
      },
      {
        id: 'assistant-1',
        parentId: 'user-1',
        type: 'message',
        message: {role: 'assistant', content: 'Use the local llama.cpp router.'},
        timestamp: '2026-07-08T12:01:00.000Z',
      },
      {
        id: 'entry-compaction',
        parentId: 'assistant-1',
        type: 'compaction',
        summary: 'Kept local llama.cpp setup details.',
        timestamp: '2026-07-08T12:02:00.000Z',
      },
    ];
    const fakeSession = {
      messages: [{role: 'user', content: 'Summarize the repo setup.'}],
      sessionFile: path.join(paths.piSessionsDir, 'compact.jsonl'),
      sessionId: 'pi-compact',
      compact: async (instructions?: string) => {
        compactInstructions = instructions;
      },
      sessionManager: {
        getBranch: () => branch,
        getLeafId: () => 'entry-compaction',
      },
    };
    let tokenizedContent = '';
    const harness = new PiHarness(paths, store, repository, new HostToolRepository(database), {
      tokenize: async content => {
        tokenizedContent = content;
        return {tokens: 42};
      },
    }) as unknown as CompactStreamHarness;
    harness.ensureSession = async () => fakeSession;

    const events = await collectAsyncQueue(
      await harness.streamCompactConversation(conversation.id, 'keep setup details'),
    );
    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.deepEqual(
      events.map(event => event.type),
      ['run.started', 'compact.started', 'context.updated', 'compact.completed', 'run.completed'],
    );
    assert.equal(events[0]?.type, 'run.started');
    assert.equal(events[0]?.kind, 'compact');
    assert.equal(events[1]?.type, 'compact.started');
    assert.equal(events[1]?.instructions, 'keep setup details');
    assert.equal(events[2]?.type, 'context.updated');
    assert.equal(events[2]?.usedTokens, 42);
    assert.equal(events[2]?.totalTokens, 8192);
    assert.equal(events[2]?.source, 'estimate');
    assert.equal(events[3]?.type, 'compact.completed');
    assert.equal(events[4]?.type, 'run.completed');
    assert.equal(events[4]?.status, 'completed');
    assert.equal(compactInstructions, 'keep setup details');
    assert.match(tokenizedContent, /summary: Kept local llama\.cpp setup details\./);
    assert.equal(snapshot?.conversation.status, 'ready');
    assert.equal(snapshot?.conversation.activeLeafPiEntryId, 'entry-compaction');
    assert.equal(snapshot?.entries[2]?.entryType, 'compaction');
    assert.equal(snapshot?.context.usedTokens, 42);
    assert.equal(snapshot?.context.totalTokens, 8192);
    assert.equal(snapshot?.context.source, 'estimate');
  } finally {
    database.close();
  }
});

test('Pi compact stream reports busy conversations with stable error codes', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const database = new AppDatabase(paths);
  await database.open();
  let releaseCompact: (() => void) | undefined;
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Busy compact'});
    const compactGate = new Promise<void>(resolve => {
      releaseCompact = resolve;
    });
    const fakeSession = {
      messages: [{role: 'user', content: 'Keep this context.'}],
      sessionFile: path.join(paths.piSessionsDir, 'busy-compact.jsonl'),
      sessionId: 'pi-busy-compact',
      compact: async () => {
        await compactGate;
      },
      sessionManager: {
        getBranch: () => [],
        getLeafId: () => null,
      },
    };
    const harness = new PiHarness(paths, store, repository, new HostToolRepository(database), {
      tokenize: async () => ({tokens: 1}),
    }) as unknown as CompactStreamHarness;
    harness.ensureSession = async () => fakeSession;

    const firstIterator = (await harness.streamCompactConversation(conversation.id))[
      Symbol.asyncIterator
    ]();
    const firstEvent = await firstIterator.next();
    assert.equal(firstEvent.value?.type, 'run.started');

    const secondEvents = await collectAsyncQueue(
      await harness.streamCompactConversation(conversation.id),
    );
    assert.equal(secondEvents[0]?.type, 'error');
    assert.equal(secondEvents[0]?.code, 'conversation_busy');
    assert.equal(secondEvents[0]?.message, 'This conversation already has an active run.');
    assert.equal(secondEvents[0]?.retryable, true);

    releaseCompact?.();
    const remainingFirstEvents = await collectAsyncIterator(firstIterator);
    assert.equal(remainingFirstEvents.at(-1)?.type, 'run.completed');
  } finally {
    releaseCompact?.();
    database.close();
  }
});

test('conversation snapshots keep variant rows separate from active path', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Regenerated answer'});
    repository.replaceConversationProjection(conversation.id, {
      activeLeafPiEntryId: 'assistant-2',
      lastSyncedPiEntryId: 'assistant-2',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Original prompt',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: 'assistant-1',
          parentPiEntryId: 'user-1',
          entryType: 'message',
          role: 'assistant',
          text: 'Original answer',
          createdAt: '2026-07-08T12:00:01.000Z',
          displayGroupId: 'assistant-1',
        },
        {
          piEntryId: 'user-2',
          entryType: 'message',
          role: 'user',
          text: 'Original prompt',
          createdAt: '2026-07-08T12:00:02.000Z',
        },
        {
          piEntryId: 'assistant-2',
          parentPiEntryId: 'user-2',
          entryType: 'message',
          role: 'assistant',
          text: 'Regenerated answer',
          createdAt: '2026-07-08T12:00:03.000Z',
          regeneratesPiEntryId: 'assistant-1',
          displayGroupId: 'assistant-1',
        },
      ],
    });

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.deepEqual(snapshot?.activePathEntryIds, ['user-2', 'assistant-2']);
    assert.deepEqual(
      snapshot?.entries.map(entry => entry.piEntryId),
      ['user-1', 'assistant-1', 'user-2', 'assistant-2'],
    );
    assert.equal(snapshot?.entries[3]?.regeneratesPiEntryId, 'assistant-1');
    assert.equal(snapshot?.entries[3]?.displayGroupId, 'assistant-1');
  } finally {
    database.close();
  }
});

test('Pi sync preserves existing answer variants when regenerating again', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Repeated regeneration'});
    repository.replaceConversationProjection(conversation.id, {
      activeLeafPiEntryId: 'assistant-2',
      lastSyncedPiEntryId: 'assistant-2',
      entries: [
        {
          piEntryId: 'user-1',
          entryType: 'message',
          role: 'user',
          text: 'Original prompt',
          createdAt: '2026-07-08T12:00:00.000Z',
        },
        {
          piEntryId: 'assistant-1',
          parentPiEntryId: 'user-1',
          entryType: 'message',
          role: 'assistant',
          text: 'Original answer',
          createdAt: '2026-07-08T12:00:01.000Z',
          displayGroupId: 'assistant-1',
        },
        {
          piEntryId: 'user-2',
          entryType: 'message',
          role: 'user',
          text: 'Original prompt',
          createdAt: '2026-07-08T12:00:02.000Z',
        },
        {
          piEntryId: 'assistant-2',
          parentPiEntryId: 'user-2',
          entryType: 'message',
          role: 'assistant',
          text: 'First regenerated answer',
          createdAt: '2026-07-08T12:00:03.000Z',
          regeneratesPiEntryId: 'assistant-1',
          displayGroupId: 'assistant-1',
        },
      ],
    });

    const activeModel: ConfiguredModel = {
      id: 'repo/model:UD-Q4_K_M',
      name: 'Model Q4',
      presetName: 'repo-model-UD-Q4_K_M',
      source: 'huggingface',
      repoId: 'repo/model',
      quant: 'UD-Q4_K_M',
      params: {contextSize: 8192},
      createdAt: '2026-07-08T12:00:00.000Z',
    };
    const assistantMessage: ChatMessage = {
      id: 'assistant-message',
      role: 'assistant',
      content: 'Second regenerated answer',
      createdAt: '2026-07-08T12:00:05.000Z',
      modelId: activeModel.id,
      modelRuntimeId: activeModel.id,
      modelAliasSnapshot: activeModel.name,
      toolCalls: [],
    };
    const session = {
      sessionFile: 'pi-session.json',
      sessionId: 'pi-session-1',
      sessionManager: {
        getLeafId: () => 'assistant-3',
        getBranch: () => [
          {
            id: 'user-3',
            parentId: null,
            type: 'message',
            timestamp: '2026-07-08T12:00:04.000Z',
            message: {role: 'user', content: 'Original prompt'},
          },
          {
            id: 'assistant-3',
            parentId: 'user-3',
            type: 'message',
            timestamp: '2026-07-08T12:00:05.000Z',
            message: {role: 'assistant', content: 'Second regenerated answer'},
          },
        ],
      },
    };
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as {
      syncPiConversation: (
        conversationId: string,
        session: unknown,
        activeModel: ConfiguredModel,
        assistantMessage: ChatMessage,
        status: 'running',
        metadata: {regeneratesPiEntryId: string; displayGroupId: string},
      ) => void;
    };
    harness.syncPiConversation(conversation.id, session, activeModel, assistantMessage, 'running', {
      regeneratesPiEntryId: 'assistant-1',
      displayGroupId: 'assistant-1',
    });

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());

    assert.deepEqual(
      snapshot?.entries.map(entry => entry.piEntryId),
      ['user-1', 'assistant-1', 'user-2', 'assistant-2', 'user-3', 'assistant-3'],
    );
    assert.deepEqual(snapshot?.activePathEntryIds, ['user-3', 'assistant-3']);
    assert.equal(snapshot?.entries[5]?.regeneratesPiEntryId, 'assistant-1');
    assert.equal(snapshot?.entries[5]?.displayGroupId, 'assistant-1');
  } finally {
    database.close();
  }
});

test('Pi sync rebuilds the active projection without dropping inactive session branches', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Branched session'});
    const sessionManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    const userEntryId = sessionManager.appendMessage({
      role: 'user',
      content: 'Choose an answer',
    } as any);
    const inactiveAssistantEntryId = sessionManager.appendMessage({
      role: 'assistant',
      content: 'First branch answer',
    } as any);
    sessionManager.branch(userEntryId);
    const activeAssistantEntryId = sessionManager.appendMessage({
      role: 'assistant',
      content: 'Second branch answer',
    } as any);
    const sessionPath = sessionManager.getSessionFile();
    assert.ok(sessionPath);

    const activeModel = createTestModel();
    const harness = new PiHarness(
      paths,
      store,
      repository,
      new HostToolRepository(database),
    ) as unknown as {
      syncPiConversation: (
        conversationId: string,
        session: unknown,
        activeModel: ConfiguredModel,
        assistantMessage?: ChatMessage,
        status?: 'ready' | 'running',
      ) => void;
    };

    harness.syncPiConversation(
      conversation.id,
      {
        sessionFile: sessionPath,
        sessionId: sessionManager.getSessionId(),
        sessionManager,
      },
      activeModel,
      undefined,
      'ready',
    );

    const snapshot = repository.getSnapshot(conversation.id, await store.getState());
    const reopened = SessionManager.open(sessionPath, paths.piSessionsDir, paths.repoRoot);

    assert.deepEqual(snapshot?.activePathEntryIds, [userEntryId, activeAssistantEntryId]);
    assert.deepEqual(
      snapshot?.entries.map(entry => entry.piEntryId),
      [userEntryId, activeAssistantEntryId],
    );
    assert.deepEqual(
      reopened.getEntries().map(entry => entry.id),
      [userEntryId, inactiveAssistantEntryId, activeAssistantEntryId],
    );
    assert.equal(reopened.getEntry(inactiveAssistantEntryId)?.type, 'message');
  } finally {
    database.close();
  }
});

test('conversation snapshot route rebuilds active projection from Pi after restart', async () => {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  let conversationId = '';
  let sessionId = '';
  let userEntryId = '';
  let assistantEntryId = '';
  try {
    const repository = new ConversationRepository(database);
    const conversation = repository.createConversation({title: 'Recover from Pi'});
    conversationId = conversation.id;
    const sessionManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    userEntryId = sessionManager.appendMessage({
      role: 'user',
      content: 'Recover this prompt',
    } as any);
    assistantEntryId = sessionManager.appendMessage({
      role: 'assistant',
      content: 'Recovered answer.',
    } as any);
    const sessionPath = sessionManager.getSessionFile();
    assert.ok(sessionPath);
    sessionId = sessionManager.getSessionId();
    repository.attachPiSession(conversation.id, {
      piSessionPath: sessionPath,
      piSessionId: sessionId,
      activeLeafPiEntryId: assistantEntryId,
    });
    repository.setConversationStatus(conversation.id, 'running');
    assert.deepEqual(repository.getConversationEntries(conversation.id), []);
  } finally {
    database.close();
  }

  const app = await createServer(paths);
  try {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
    });
    assert.equal(response.statusCode, 200);
    const snapshot = response.json<{
      snapshot: {
        conversation: {status: string; piSessionId?: string; activeLeafPiEntryId?: string};
        entries: Array<{piEntryId: string; textPreview?: string}>;
        activePathEntryIds: string[];
      };
    }>().snapshot;

    assert.equal(snapshot.conversation.status, 'ready');
    assert.equal(snapshot.conversation.piSessionId, sessionId);
    assert.equal(snapshot.conversation.activeLeafPiEntryId, assistantEntryId);
    assert.deepEqual(snapshot.activePathEntryIds, [userEntryId, assistantEntryId]);
    assert.deepEqual(
      snapshot.entries.map(entry => [entry.piEntryId, entry.textPreview]),
      [
        [userEntryId, 'Recover this prompt'],
        [assistantEntryId, 'Recovered answer.'],
      ],
    );
  } finally {
    await app.close();
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
    const defaultSnapshot = snapshotResponse.json<{
      snapshot: {conversation: {piSessionId?: string}; entries: unknown[]};
    }>().snapshot;
    assert.equal(defaultSnapshot.entries.length, 1);
    assert.ok(defaultSnapshot.conversation.piSessionId);

    let sessionHeaders = await readSessionHeaders(paths.piSessionsDir);
    assert.equal(sessionHeaders.length, 1);
    assert.equal(sessionHeaders[0]?.id, defaultSnapshot.conversation.piSessionId);

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {title: 'New durable chat'},
    });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json<{
      conversation: {id: string; title: string; pinned: boolean; piSessionId?: string};
      snapshot: {conversation: {piSessionId?: string}; entries: unknown[]};
    }>();
    assert.equal(created.conversation.title, 'New durable chat');
    assert.ok(created.conversation.piSessionId);
    assert.equal(created.snapshot.conversation.piSessionId, created.conversation.piSessionId);
    assert.deepEqual(created.snapshot.entries, []);

    sessionHeaders = await readSessionHeaders(paths.piSessionsDir);
    assert.equal(sessionHeaders.length, 2);
    assert.ok(
      sessionHeaders.some(header => header.id === defaultSnapshot.conversation.piSessionId),
    );
    assert.ok(sessionHeaders.some(header => header.id === created.conversation.piSessionId));

    const patchResponse = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${created.conversation.id}`,
      payload: {title: 'Renamed chat'},
    });
    assert.equal(patchResponse.statusCode, 200);
    assert.equal(
      patchResponse.json<{conversation: {title: string}}>().conversation.title,
      'Renamed chat',
    );

    const pinResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.conversation.id}/pin`,
    });
    assert.equal(pinResponse.statusCode, 200);
    assert.equal(pinResponse.json<{conversation: {pinned: boolean}}>().conversation.pinned, true);

    const abortResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.conversation.id}/abort`,
    });
    assert.equal(abortResponse.statusCode, 200);
    const aborted = abortResponse.json<{
      ok: boolean;
      aborted: boolean;
      snapshot: {conversation: {id: string}};
    }>();
    assert.equal(aborted.ok, true);
    assert.equal(aborted.aborted, false);
    assert.equal(aborted.snapshot.conversation.id, created.conversation.id);

    const compactionAbortResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.conversation.id}/compact/abort`,
    });
    assert.equal(compactionAbortResponse.statusCode, 200);
    assert.equal(compactionAbortResponse.json<{aborted: boolean}>().aborted, false);

    const deleteResponse = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${created.conversation.id}`,
    });
    assert.equal(deleteResponse.statusCode, 200);
    assert.equal(deleteResponse.json<{ok: boolean}>().ok, true);
  } finally {
    await app.close();
  }
});

test('host tool settings require acknowledgement before enabling tools', async () => {
  const paths = await createTempPaths();
  const app = await createServer(paths);
  try {
    const stateResponse = await app.inject({method: 'GET', url: '/api/state'});
    assert.equal(stateResponse.statusCode, 200);
    const initialSettings = stateResponse.json<{
      hostTools: {enabled: boolean; acknowledged: boolean};
    }>().hostTools;
    assert.equal(initialSettings.enabled, false);
    assert.equal(initialSettings.acknowledged, false);

    const rejectedResponse = await app.inject({
      method: 'PATCH',
      url: '/api/settings/host-tools',
      payload: {enabled: true},
    });
    assert.equal(rejectedResponse.statusCode, 400);
    assert.equal(
      rejectedResponse.json<{error: {code: string}}>().error.code,
      'host_tools_acknowledgement_required',
    );

    const enabledResponse = await app.inject({
      method: 'PATCH',
      url: '/api/settings/host-tools',
      payload: {enabled: true, acknowledged: true},
    });
    assert.equal(enabledResponse.statusCode, 200);
    const enabledSettings = enabledResponse.json<{
      hostTools: {enabled: boolean; acknowledged: boolean};
    }>().hostTools;
    assert.equal(enabledSettings.enabled, true);
    assert.equal(enabledSettings.acknowledged, true);

    const disabledResponse = await app.inject({
      method: 'PATCH',
      url: '/api/settings/host-tools',
      payload: {enabled: false},
    });
    assert.equal(disabledResponse.statusCode, 200);
    const disabledSettings = disabledResponse.json<{
      hostTools: {enabled: boolean; acknowledged: boolean};
    }>().hostTools;
    assert.equal(disabledSettings.enabled, false);
    assert.equal(disabledSettings.acknowledged, true);
  } finally {
    await app.close();
  }
});

test('chat stream emits SSE envelopes with run lifecycle events', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const originalFetch = globalThis.fetch;
  const previousPiDisabled = process.env.NELLE_PI_DISABLED;
  process.env.NELLE_PI_DISABLED = '1';
  globalThis.fetch = (async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes('/slots')) {
      return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}});
    }
    return new Response(
      [
        'data: {"choices":[{"delta":{"content":"Direct answer."}}]}',
        '',
        'data: {"timings":{"prompt_n":4,"prompt_ms":10,"prompt_per_second":400,"predicted_n":2,"predicted_ms":20,"predicted_per_second":100}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      {status: 200, headers: {'content-type': 'text/event-stream'}},
    );
  }) as typeof fetch;

  const app = await createServer(paths);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/chat/stream',
      payload: {message: 'hello'},
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /event: run\.started/);
    assert.match(response.body, /event: run\.completed/);
    const envelopes = parseSseEnvelopes(response.body);
    assert.ok(envelopes.every(envelope => envelope.id && envelope.createdAt));
    assert.deepEqual(
      envelopes
        .map(envelope => envelope.data?.type)
        .filter(
          type =>
            type === 'run.started' ||
            type === 'message.assistant.completed' ||
            type === 'run.completed' ||
            type === 'done',
        ),
      ['run.started', 'message.assistant.completed', 'done', 'run.completed'],
    );
    const runStarted = envelopes.find(envelope => envelope.data?.type === 'run.started');
    const runCompleted = envelopes.find(envelope => envelope.data?.type === 'run.completed');
    assert.equal(runStarted?.runId, runCompleted?.runId);
    assert.equal(runCompleted?.data?.status, 'completed');
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    if (previousPiDisabled == null) {
      delete process.env.NELLE_PI_DISABLED;
    } else {
      process.env.NELLE_PI_DISABLED = previousPiDisabled;
    }
  }
});

test('llama proxy forwards an abort signal to upstream chat completions', async () => {
  const paths = await createTempPaths();
  const originalFetch = globalThis.fetch;
  let upstreamSignal: AbortSignal | undefined;
  let upstreamSignalWasAbortedAtFetch: boolean | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    upstreamSignal = init?.signal ?? undefined;
    upstreamSignalWasAbortedAtFetch = upstreamSignal?.aborted;
    return new Response(JSON.stringify({choices: [], timings: {}}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  }) as typeof fetch;

  const app = await createServer(paths);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/llama-proxy/v1/chat/completions',
      payload: {model: 'local-model', messages: [], stream: false},
    });
    assert.equal(response.statusCode, 200);
    assert.ok(upstreamSignal instanceof AbortSignal);
    assert.equal(upstreamSignalWasAbortedAtFetch, false);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
  }
});

type TitleGenerationHarness = {
  maybeGenerateConversationTitle: (
    conversationId: string,
    activeModel: ConfiguredModel,
    entries: Array<{
      piEntryId: string;
      entryType: string;
      role?: ChatMessage['role'] | null;
      text: string;
      createdAt: string;
    }>,
  ) => Promise<string | null>;
  streamConversationTitleIfNeeded: (
    conversationId: string,
    activeModel: ConfiguredModel,
    entries: Array<{
      piEntryId: string;
      entryType: string;
      role?: ChatMessage['role'] | null;
      text: string;
      createdAt: string;
    }>,
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
  ) => Promise<void>;
  abortConversationRun: (
    conversationId: string,
    runId: string,
  ) => Promise<{aborted: boolean; warning?: {code: string; message: string}}>;
};

type CompactStreamHarness = {
  ensureSession: () => Promise<{
    messages: Array<{role: string; content: string}>;
    sessionFile: string;
    sessionId: string;
    compact: (instructions?: string) => Promise<void>;
    sessionManager: {
      getBranch: () => Array<unknown>;
      getLeafId: () => string;
    };
  }>;
  streamCompactConversation: (
    conversationId: string,
    customInstructions?: string,
  ) => Promise<AsyncIterable<ChatStreamEvent>>;
};

async function collectAsyncQueue<T>(queue: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

async function collectAsyncIterator<T>(iterator: AsyncIterator<T>): Promise<T[]> {
  const items: T[] = [];
  while (true) {
    const item = await iterator.next();
    if (item.done) {
      break;
    }
    items.push(item.value);
  }
  return items;
}

function parseSseEnvelopes(body: string): Array<{
  id: string;
  type: string;
  runId?: string;
  createdAt: string;
  data?: {type?: string; status?: string};
}> {
  return body
    .split('\n\n')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map(chunk => {
      const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
      assert.ok(dataLine);
      return JSON.parse(dataLine.slice(6));
    });
}

function createTestModel(): ConfiguredModel {
  return {
    id: 'repo/model:UD-Q4_K_M',
    name: 'Model Q4',
    presetName: 'repo-model-UD-Q4_K_M',
    source: 'huggingface',
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    params: {contextSize: 8192},
    createdAt: '2026-07-08T12:00:00.000Z',
  };
}

function createFirstTurnEntries(): Array<{
  piEntryId: string;
  entryType: string;
  role: ChatMessage['role'];
  text: string;
  createdAt: string;
}> {
  return [
    {
      piEntryId: 'user-1',
      entryType: 'message',
      role: 'user',
      text: 'Explain local setup',
      createdAt: '2026-07-08T12:00:00.000Z',
    },
    {
      piEntryId: 'assistant-1',
      entryType: 'message',
      role: 'assistant',
      text: 'Use llama.cpp locally',
      createdAt: '2026-07-08T12:01:00.000Z',
    },
  ];
}

async function readSessionHeaders(sessionDir: string): Promise<Array<{type: string; id: string}>> {
  const files = await fs.readdir(sessionDir);
  const headers: Array<{type: string; id: string}> = [];
  for (const file of files) {
    const sessionPath = path.join(sessionDir, file);
    if (!(await fs.stat(sessionPath)).isFile()) {
      continue;
    }
    const firstLine = (await fs.readFile(sessionPath, 'utf8')).split(/\r?\n/)[0];
    const header = JSON.parse(firstLine ?? '{}') as {type: string; id: string};
    assert.equal(header.type, 'session');
    headers.push(header);
  }
  return headers;
}

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
