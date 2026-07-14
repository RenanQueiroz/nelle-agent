import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {ConversationRepository} from '../../apps/server/src/conversations.ts';
import {createTestServer} from './helpers/testServer.ts';
import {tempPaths} from './helpers/paths.ts';
import {removeTemp} from './helpers/platform.ts';

/**
 * `GET /api/attachments/:id/content` exists because of the phone.
 *
 * A past message's bytes are not on the client and never were: the composer can preview
 * an image because it just read those bytes off disk, but a transcript rebuilt from a
 * snapshot has only metadata. Without this route the only honest thing to render for a
 * past attachment is a chip.
 */
async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-attach-'));
  const paths = tempPaths(dataDir);
  const app = await createTestServer(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const conversations = new ConversationRepository(database);
  await conversations.init();
  return {app, database, conversations, paths, dataDir};
}

/** Writes a file under the attachments tree and returns its data-dir-relative path. */
async function writeAttachmentFile(
  attachmentsDir: string,
  dataDir: string,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const target = path.join(attachmentsDir, 'ab', name);
  await fs.mkdir(path.dirname(target), {recursive: true});
  await fs.writeFile(target, bytes);
  return path.relative(dataDir, target).split(path.sep).join('/');
}

function insertAttachment(
  database: AppDatabase,
  row: {id: string; conversationId: string; storagePath: string | null; mimeType?: string},
): void {
  database.connection
    .prepare(
      `INSERT INTO message_attachments
       (id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type, size_bytes,
        storage_path, text_content, processing_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.conversationId,
      'entry-1',
      null,
      'image',
      'photo.png',
      row.mimeType ?? 'image/png',
      3,
      row.storagePath,
      null,
      null,
      new Date().toISOString(),
    );
}

test('an attachment serves its bytes with its own content type', async () => {
  const {app, database, conversations, paths, dataDir} = await setup();
  try {
    const conversation = conversations.createConversation({title: 'c'});
    const bytes = Buffer.from([0x89, 0x50, 0x4e]);
    const storagePath = await writeAttachmentFile(
      paths.attachmentsDir,
      paths.dataDir,
      'photo.png',
      bytes,
    );
    insertAttachment(database, {
      id: 'att-1',
      conversationId: conversation.id,
      storagePath,
    });

    const response = await app.inject({method: 'GET', url: '/api/attachments/att-1/content'});

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.deepEqual(response.rawPayload, bytes);
    // Content-addressed: the bytes at this id can never change, so a phone may keep
    // them forever rather than re-fetching a transcript's images on every open.
    assert.match(response.headers['cache-control'] ?? '', /immutable/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    database.close();
    await app.close();
    await removeTemp(dataDir);
  }
});

test('a storage path that escapes the attachments tree is refused, not served', async () => {
  const {app, database, conversations, dataDir} = await setup();
  try {
    const conversation = conversations.createConversation({title: 'c'});
    // `storage_path` comes out of the database, so it is data, not a capability. A row
    // must never be able to name any file on the machine and have it handed over.
    insertAttachment(database, {
      id: 'att-escape',
      conversationId: conversation.id,
      storagePath: '../../../../etc/passwd',
    });

    const response = await app.inject({method: 'GET', url: '/api/attachments/att-escape/content'});

    assert.equal(response.statusCode, 404);
  } finally {
    database.close();
    await app.close();
    await removeTemp(dataDir);
  }
});

test('an attachment with no stored bytes is a 404, not an empty 200', async () => {
  const {app, database, conversations, dataDir} = await setup();
  try {
    const conversation = conversations.createConversation({title: 'c'});
    // A text attachment lives in the database, not on disk.
    insertAttachment(database, {
      id: 'att-text',
      conversationId: conversation.id,
      storagePath: null,
    });

    const response = await app.inject({method: 'GET', url: '/api/attachments/att-text/content'});

    assert.equal(response.statusCode, 404);
  } finally {
    database.close();
    await app.close();
    await removeTemp(dataDir);
  }
});

test('an unknown attachment id is a 404', async () => {
  const {app, database, dataDir} = await setup();
  try {
    const response = await app.inject({method: 'GET', url: '/api/attachments/nope/content'});
    assert.equal(response.statusCode, 404);
  } finally {
    database.close();
    await app.close();
    await removeTemp(dataDir);
  }
});

test('a row whose file was swept is a 404 rather than a crash', async () => {
  const {app, database, conversations, paths, dataDir} = await setup();
  try {
    const conversation = conversations.createConversation({title: 'c'});
    const storagePath = await writeAttachmentFile(
      paths.attachmentsDir,
      paths.dataDir,
      'gone.png',
      Buffer.from([1]),
    );
    insertAttachment(database, {
      id: 'att-gone',
      conversationId: conversation.id,
      storagePath,
    });
    await fs.rm(path.join(paths.dataDir, storagePath));

    const response = await app.inject({method: 'GET', url: '/api/attachments/att-gone/content'});

    assert.equal(response.statusCode, 404);
  } finally {
    database.close();
    await app.close();
    await removeTemp(dataDir);
  }
});
