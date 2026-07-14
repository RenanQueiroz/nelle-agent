import assert from 'node:assert/strict';
import path from 'node:path';
import {test} from 'bun:test';

import {SessionManager} from '@earendil-works/pi-coding-agent';
import {strFromU8, unzipSync} from 'fflate';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {ConversationRepository} from '../../apps/server/src/conversations.ts';

import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  cloneConversationRequestSchema,
  conversationArchiveManifestSchema,
  conversationCreatedResponseSchema,
  conversationDiagnosticsSchema,
  conversationListResponseSchema,
  forkConversationRequestSchema,
} from '../../apps/server/src/contracts/conversations.ts';
import {createTestServer} from './helpers/testServer.ts';
import {createTempPaths} from './helpers/paths.ts';

/**
 * **The conversation lifecycle is a contract, not a set of shapes each client guesses at.**
 *
 * `ConversationDiagnostics` lived in `apps/web/src/api.ts` and nowhere else: hand-written, in the
 * one place a second client could never see it. `forkConversationSchema` and
 * `cloneConversationSchema` were `const`s local to `server.ts`. That is precisely the
 * copy-of-the-copy that serving an OpenAPI document exists to prevent -- and it is the same thing
 * the runtime and model DTOs were before M7 T2.
 */

test('fork REQUIRES an entry, and clone does not -- that is the whole difference', () => {
  // A fork starts a new conversation from a point *inside* this one, so it must be told which
  // point: it is a transcript action, a footer on a user message. A clone duplicates the
  // conversation, so it needs nothing: it is a sidebar action. Collapsing the two into one
  // "duplicate" is the obvious mistake, and it loses the ability to branch a chat at all.
  assert.throws(() => forkConversationRequestSchema.parse({}));
  assert.deepEqual(forkConversationRequestSchema.parse({entryId: 'e1'}), {entryId: 'e1'});

  assert.deepEqual(cloneConversationRequestSchema.parse({}), {});
  assert.deepEqual(cloneConversationRequestSchema.parse({entryId: 'e1'}), {entryId: 'e1'});
});

test('an empty entryId is not an entryId', () => {
  assert.throws(() => forkConversationRequestSchema.parse({entryId: ''}));
  assert.throws(() => cloneConversationRequestSchema.parse({entryId: ''}));
});

test('diagnostics say WHY a conversation is unavailable, not merely that it is', () => {
  // `exists: false` plus the filesystem's own `reason` is the interesting case -- it is what
  // lets a user choose between repair (put the file back) and rebuild (accept the loss) with
  // the facts in front of them instead of guessing.
  const broken = conversationDiagnosticsSchema.parse({
    conversationId: 'c1',
    status: 'unavailable',
    piSessionPath: '/data/pi/sessions/c1.jsonl',
    exists: false,
    reason: 'ENOENT: no such file or directory',
    projectionEntryCount: 12,
    attachmentCount: 2,
    toolAuditCount: 0,
  });
  assert.equal(broken.exists, false);
  assert.match(broken.reason ?? '', /ENOENT/);
  // The ceiling on what a rebuild could recover. A rebuild reconstructs the Pi session from the
  // projection, so this number *is* the most it can give back.
  assert.equal(broken.projectionEntryCount, 12);

  // A healthy conversation carries no reason, and that is not an omission.
  const healthy = conversationDiagnosticsSchema.parse({
    conversationId: 'c2',
    status: 'ready',
    exists: true,
    projectionEntryCount: 4,
    attachmentCount: 0,
    toolAuditCount: 0,
  });
  assert.equal(healthy.reason, undefined);
});

test('the manifest declares a lost session, which is what makes an import refusable', () => {
  // Exporting an `unavailable` conversation is **allowed** -- you should be able to get your data
  // out of a broken chat -- and the archive says so. Importing that archive is then refused with
  // `archive_session_missing`, because the alternative is silently creating an empty conversation,
  // which looks exactly like success.
  const manifest = conversationArchiveManifestSchema.parse({
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: '2026-07-13T00:00:00.000Z',
    appVersion: '0.1.0',
    conversation: {id: 'c1', title: 'A broken chat'},
    source: {platform: 'linux'},
    piSessionMissing: true,
    files: {'manifest.json': 'sha256:abc'},
  });
  assert.equal(manifest.piSessionMissing, true);
  assert.equal(manifest.conversation?.title, 'A broken chat');
});

test('the archive format and version are literals, so a foreign zip cannot parse as one', () => {
  const base = {
    exportedAt: '2026-07-13T00:00:00.000Z',
    appVersion: '0.1.0',
    files: {},
  };
  assert.throws(() =>
    conversationArchiveManifestSchema.parse({...base, format: 'not-nelle', version: 1}),
  );
  // A future archive version is refused rather than half-read. Nelle has no users, so there is
  // no v1-reader-meets-v2-archive to be gentle about -- and half-reading an archive is worse
  // than refusing it.
  assert.throws(() =>
    conversationArchiveManifestSchema.parse({...base, format: ARCHIVE_FORMAT, version: 2}),
  );
});

test('the archive constants live with the schema that validates them', () => {
  // They used to be `const`s inside `conversationArchive.ts` while the schema hard-coded the same
  // two literals a file away. Bump one and Nelle writes archives it then refuses to read.
  assert.equal(ARCHIVE_FORMAT, 'nelle-chat');
  assert.equal(ARCHIVE_VERSION, 1);
});

/**
 * The contract is only worth anything if it describes what the server actually sends. These parse
 * **real responses from the real routes** with the schemas the Dart client is generated from --
 * so a route that drifts from its schema fails here rather than in a phone six weeks later.
 */

test('the routes answer what the contract says they answer', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {title: 'Contract'},
    });
    assert.equal(created.statusCode, 200);
    const id = created.json<{conversation: {id: string}}>().conversation.id;

    // GET /api/conversations -> ConversationListResponse
    const list = await app.inject({method: 'GET', url: '/api/conversations'});
    assert.equal(list.statusCode, 200);
    conversationListResponseSchema.parse(list.json());

    // GET /api/conversations/:id/diagnostics -> {diagnostics: ConversationDiagnostics}
    const diagnostics = await app.inject({
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent(id)}/diagnostics`,
    });
    assert.equal(diagnostics.statusCode, 200);
    const parsed = conversationDiagnosticsSchema.parse(
      diagnostics.json<{diagnostics: unknown}>().diagnostics,
    );
    assert.equal(parsed.conversationId, id);
    assert.equal(parsed.exists, true, 'a conversation Nelle just created has its session file');

    // **Cloning an EMPTY conversation is refused, with a code.** A conversation Nelle just created
    // has a header-only Pi session and no entries at all, so there is genuinely nothing to
    // duplicate. That used to throw and come back as a bare `500` with no code -- a thing no
    // client can render, and which the browser only never hit by luck. It is a 409 now.
    const cloned = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(id)}/clone`,
    });
    assert.equal(cloned.statusCode, 409);
    const refusal = cloned.json<{error: {code: string; message: string}}>().error;
    assert.equal(refusal.code, 'conversation_not_branchable');
    assert.match(refusal.message, /no messages yet/);

    // The source conversation is of course untouched.
    const source = await app.inject({
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent(id)}`,
    });
    assert.equal(source.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('an exported archive carries a manifest the contract can read', async () => {
  // The zip is not in the contract and never will be -- but the manifest inside it is, because a
  // client must be able to say what an archive *is* before it imports it.
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: {title: 'Export me'},
    });
    const id = created.json<{conversation: {id: string}}>().conversation.id;

    const exported = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(id)}/export`,
    });
    assert.equal(exported.statusCode, 200);
    assert.equal(exported.headers['content-type'], 'application/zip');
    // The filename is what a desktop Save dialog offers and what a phone shares.
    assert.match(String(exported.headers['content-disposition']), /\.nelle-chat\.zip/);

    const archive = unzipSync(new Uint8Array(exported.rawPayload));
    const manifest = conversationArchiveManifestSchema.parse(
      JSON.parse(strFromU8(archive['manifest.json']!)),
    );
    assert.equal(manifest.format, ARCHIVE_FORMAT);
    assert.equal(manifest.version, ARCHIVE_VERSION);
    assert.equal(manifest.conversation?.id, id);
    assert.equal(manifest.piSessionMissing, false, 'this session is fine');
    // Every file is checksummed, and the import verifies all of them.
    assert.ok(Object.keys(manifest.files).length > 0);
  } finally {
    await app.close();
  }
});

test('a fork and a clone both answer ConversationCreatedResponse, and leave the source alone', async () => {
  // Seeded with real Pi entries, because that is the only state in which either is possible.
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const repository = new ConversationRepository(database);
  await repository.init();
  const source = repository.createConversation({title: 'Source'});
  const manager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
  const userEntryId = manager.appendMessage({
    role: 'user',
    content: 'Branch from here',
  } as never);
  const assistantEntryId = manager.appendMessage({
    role: 'assistant',
    content: 'An answer',
  } as never);
  const sessionPath = manager.getSessionFile()!;
  repository.attachPiSession(source.id, {
    piSessionPath: sessionPath,
    piSessionId: manager.getSessionId(),
    activeLeafPiEntryId: assistantEntryId,
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    // A **fork** branches at a user message: it is a transcript action, and it must be told where.
    const forked = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(source.id)}/fork`,
      payload: {entryId: userEntryId},
    });
    assert.equal(forked.statusCode, 200);
    const fork = conversationCreatedResponseSchema.parse(forked.json());
    assert.notEqual(fork.conversation.id, source.id);
    assert.equal(fork.snapshot.conversation.forkKind, 'fork');
    assert.equal(fork.snapshot.conversation.forkedFromPiEntryId, userEntryId);
    assert.equal(fork.snapshot.conversation.parentConversationId, source.id);

    // A **clone** duplicates the whole thing: a sidebar action, and it needs no body.
    const cloned = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(source.id)}/clone`,
    });
    assert.equal(cloned.statusCode, 200);
    const clone = conversationCreatedResponseSchema.parse(cloned.json());
    assert.equal(clone.snapshot.conversation.forkKind, 'clone');
    assert.notEqual(clone.conversation.id, source.id);

    // The source is untouched by both -- that is the whole promise.
    const after = await app.inject({
      method: 'GET',
      url: `/api/conversations/${encodeURIComponent(source.id)}`,
    });
    assert.equal(after.statusCode, 200);
    assert.equal(
      after.json<{snapshot: {conversation: {title: string}}}>().snapshot.conversation.title,
      'Source',
    );
  } finally {
    await app.close();
  }
});

test('forking from an ASSISTANT message is refused, not crashed', async () => {
  // A fork replays *your* prompt down a new branch. There is no meaning to forking from the
  // model's answer, and the server says so with a code rather than a 500.
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const repository = new ConversationRepository(database);
  await repository.init();
  const source = repository.createConversation({title: 'Source'});
  const manager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
  manager.appendMessage({role: 'user', content: 'A prompt'} as never);
  const assistantEntryId = manager.appendMessage({
    role: 'assistant',
    content: 'An answer',
  } as never);
  repository.attachPiSession(source.id, {
    piSessionPath: manager.getSessionFile()!,
    piSessionId: manager.getSessionId(),
    activeLeafPiEntryId: assistantEntryId,
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(source.id)}/fork`,
      payload: {entryId: assistantEntryId},
    });
    assert.equal(response.statusCode, 409);
    const error = response.json<{error: {code: string; message: string}}>().error;
    assert.equal(error.code, 'conversation_not_branchable');
    assert.match(error.message, /your own messages/);
  } finally {
    await app.close();
  }
});

test('a valid archive with no history is NOT "corrupt": the two refusals are distinguishable', async () => {
  // Exporting an `unavailable` conversation is allowed on purpose -- you must be able to salvage
  // your data from a broken chat -- and the archive records that its Pi session was already lost.
  // Importing it is then refused, because the alternative is silently creating an empty
  // conversation, which looks exactly like success.
  //
  // But it is refused for a *specific* reason: the zip is perfectly valid, it simply carries no
  // history. The route hard-coded `invalid_archive` for every failure, so it told the user their
  // file was corrupt -- and left `archive_session_missing` in `NELLE_ERROR_CODES` as a code
  // nothing ever emitted, which is a promise the contract makes and does not keep.
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  const repository = new ConversationRepository(database);
  await repository.init();
  const conversation = repository.createConversation({title: 'Salvage me'});
  repository.attachPiSession(conversation.id, {
    piSessionPath: path.join(paths.piSessionsDir, 'gone.jsonl'),
    piSessionId: 'gone-session',
  });
  await repository.markUnavailableIfPiSessionInvalid(conversation.id);
  database.close();

  const app = await createTestServer(paths);
  try {
    const exported = await app.inject({
      method: 'POST',
      url: `/api/conversations/${encodeURIComponent(conversation.id)}/export`,
    });
    assert.equal(exported.statusCode, 200, 'a broken conversation still exports');

    const manifest = conversationArchiveManifestSchema.parse(
      JSON.parse(strFromU8(unzipSync(new Uint8Array(exported.rawPayload))['manifest.json']!)),
    );
    assert.equal(manifest.piSessionMissing, true, 'and the archive says so');

    // The specific code, not the generic one.
    const imported = await app.inject({
      method: 'POST',
      url: '/api/conversations/import',
      payload: Buffer.from(exported.rawPayload),
      headers: {'content-type': 'application/zip'},
    });
    assert.equal(imported.statusCode, 400);
    const error = imported.json<{error: {code: string; message: string}}>().error;
    assert.equal(error.code, 'archive_session_missing');
    assert.match(error.message, /no message history/);

    // ...and a genuinely corrupt zip still gets the generic one, or the distinction is worthless.
    const corrupt = await app.inject({
      method: 'POST',
      url: '/api/conversations/import',
      payload: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]),
      headers: {'content-type': 'application/zip'},
    });
    assert.equal(corrupt.statusCode, 400);
    assert.equal(corrupt.json<{error: {code: string}}>().error.code, 'invalid_archive');
  } finally {
    await app.close();
  }
});

test('branching a BROKEN conversation is a 409, not a 500', () => {
  // A conversation whose Pi session file is gone has no history to branch. M8 T1 gave
  // `conversation_not_branchable` a 409 and missed this one, so it kept falling through to a bare
  // 500 -- a refusal in a form no client can render, which is the whole thing that fix was about.
  //
  // The M9 device suite found it: cloning the fixture's conversation-with-no-session answered 500.
  // A widget test stubs the response and would never have noticed.
  return (async () => {
    const paths = await createTempPaths();
    const database = new AppDatabase(paths);
    await database.open();
    const repository = new ConversationRepository(database);
    await repository.init();
    const conversation = repository.createConversation({title: 'Broken'});
    repository.attachPiSession(conversation.id, {
      piSessionPath: path.join(paths.piSessionsDir, 'never-written.jsonl'),
      piSessionId: 'gone',
    });
    await repository.markUnavailableIfPiSessionInvalid(conversation.id);
    database.close();

    const app = await createTestServer(paths);
    try {
      for (const action of ['clone', 'fork'] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/api/conversations/${encodeURIComponent(conversation.id)}/${action}`,
          payload: action === 'fork' ? {entryId: 'e1'} : undefined,
        });
        assert.equal(response.statusCode, 409, `${action} must refuse, not crash`);
        assert.equal(response.json<{error: {code: string}}>().error.code, 'session_unavailable');
      }
    } finally {
      await app.close();
    }
  })();
});
