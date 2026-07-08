import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {ConversationRepository} from '../../apps/server/src/conversations.ts';
import {AppDatabase} from '../../apps/server/src/database.ts';
import {PiHarness} from '../../apps/server/src/piHarness.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {createServer} from '../../apps/server/src/server.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import type {ChatMessage, ConfiguredModel} from '../../apps/server/src/types.ts';
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
    const harness = new PiHarness(paths, store, repository) as unknown as TitleGenerationHarness;

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
    const harness = new PiHarness(paths, store, repository) as unknown as TitleGenerationHarness;

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
    const harness = new PiHarness(paths, store, repository) as unknown as TitleGenerationHarness;

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
    const harness = new PiHarness(paths, store, repository) as unknown as {
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

    const compactionAbortResponse = await app.inject({
      method: 'POST',
      url: `/api/conversations/${created.id}/compact/abort`,
    });
    assert.equal(compactionAbortResponse.statusCode, 200);
    assert.equal(compactionAbortResponse.json<{aborted: boolean}>().aborted, false);

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
};

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
