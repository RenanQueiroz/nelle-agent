import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'bun:test';

import {AppDatabase} from '../../../apps/server/src/db/database.ts';
import {ModelCacheRepository} from '../../../apps/server/src/models/cache.ts';
import {ConversationRepository} from '../../../apps/server/src/conversations/repository.ts';
import {createTestServer} from '../helpers/testServer.ts';
import {createTempPaths} from '../helpers/paths.ts';
import {AppStore} from '../../../apps/server/src/models/store.ts';
import {ATTACHMENT_LIMITS} from '../../../apps/server/src/contracts/attachments.ts';
import {imageOnlyPdfBuffer, simplePdfBuffer} from '../helpers/pdf.ts';

const BOUNDARY = 'nelleboundary';

test('a text upload is stored, classified, and its text extracted', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({name: 'notes.md', mimeType: 'text/markdown', bytes: Buffer.from('hello')}),
    );
    assert.equal(response.statusCode, 201);
    const body = response.json<{
      uploadId: string;
      kind: string;
      sizeBytes: number;
      textPreview?: string;
      warnings: string[];
    }>();
    assert.equal(body.kind, 'text');
    assert.equal(body.sizeBytes, 5);
    assert.equal(body.textPreview, 'hello');
    assert.deepEqual(body.warnings, []);

    // The bytes are on disk, under the uploads tree.
    const stored = await fs.readFile(path.join(paths.uploadsDir, body.uploadId, 'content'), 'utf8');
    assert.equal(stored, 'hello');

    const fetched = await app.inject({method: 'GET', url: `/api/uploads/${body.uploadId}`});
    assert.equal(fetched.statusCode, 200);
    assert.deepEqual(fetched.json<{text: string; bound: boolean}>().text, 'hello');
    assert.equal(fetched.json<{bound: boolean}>().bound, false);
  } finally {
    await app.close();
  }
});

test('a PDF upload is extracted server-side and reports its page count', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({
        name: 'report.pdf',
        mimeType: 'application/pdf',
        bytes: simplePdfBuffer('Quarterly revenue rose'),
      }),
    );
    assert.equal(response.statusCode, 201);
    const body = response.json<{kind: string; pageCount?: number; textPreview?: string}>();
    assert.equal(body.kind, 'pdf');
    assert.equal(body.pageCount, 1);
    assert.match(body.textPreview ?? '', /Quarterly revenue rose/);
  } finally {
    await app.close();
  }
});

test('a PDF with no text layer is accepted and reports its pages', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        // A page that draws a rectangle and no text: what a scan looks like.
        bytes: imageOnlyPdfBuffer(),
      }),
    );
    assert.equal(response.statusCode, 201);
    const body = response.json<{kind: string; hasTextLayer: boolean; textPreview?: string}>();
    assert.equal(body.kind, 'pdf');
    // There is nothing to extract, so the pages are the document.
    assert.equal(body.hasTextLayer, false);
    assert.equal(body.textPreview, undefined);
  } finally {
    await app.close();
  }
});

test('a PDF with a text layer says so, so the chip can name what will be sent', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const body = (
      await app.inject(
        uploadRequest({
          name: 'report.pdf',
          mimeType: 'application/pdf',
          bytes: simplePdfBuffer('Quarterly revenue rose'),
        }),
      )
    ).json<{hasTextLayer: boolean; pageCount: number}>();
    assert.equal(body.hasTextLayer, true);
    assert.equal(body.pageCount, 1);
  } finally {
    await app.close();
  }
});

test('a scan is refused for a model llama.cpp has proven cannot see', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Text Only',
  });
  await store.setActiveModel(model.id);

  const database = new AppDatabase(paths);
  await database.open();
  new ModelCacheRepository(database).upsertModelProps(model.id, {
    modelId: model.id,
    modalities: {vision: false, audio: false, video: false},
    canReason: null,
    raw: {},
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({name: 'scan.pdf', mimeType: 'application/pdf', bytes: imageOnlyPdfBuffer()}),
    );
    assert.equal(response.statusCode, 400);
    const {error} = response.json<{error: {code: string; message: string}}>();
    assert.equal(error.code, 'unsupported_attachment');
    assert.match(error.message, /scan\.pdf has no text layer/);
    assert.match(error.message, /Choose a vision model/);
  } finally {
    await app.close();
  }
});

test('a scan is accepted while the model vision support is unproven', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Never Loaded',
  });
  await store.setActiveModel(model.id);

  const app = await createTestServer(paths);
  try {
    // `null` is not `false`. The user can still load the model.
    const response = await app.inject(
      uploadRequest({name: 'scan.pdf', mimeType: 'application/pdf', bytes: imageOnlyPdfBuffer()}),
    );
    assert.equal(response.statusCode, 201);
  } finally {
    await app.close();
  }
});

test('a binary file is refused with a coded error, not an HTTP 500', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({name: 'a.txt', bytes: Buffer.from([0x68, 0x00, 0x69])}),
    );
    assert.equal(response.statusCode, 400);
    const {error} = response.json<{error: {code: string; message: string}}>();
    assert.equal(error.code, 'unsupported_attachment');
    assert.match(error.message, /looks like a binary file/);
  } finally {
    await app.close();
  }
});

test('an upload with no file is an invalid request', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {'content-type': `multipart/form-data; boundary=${BOUNDARY}`},
      payload: `--${BOUNDARY}--\r\n`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json<{error: {code: string}}>().error.code, 'invalid_request');
  } finally {
    await app.close();
  }
});

test('an image is refused for a model llama.cpp has proven cannot see it', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Text Only',
  });
  await store.setActiveModel(model.id);

  const database = new AppDatabase(paths);
  await database.open();
  new ModelCacheRepository(database).upsertModelProps(model.id, {
    modelId: model.id,
    modalities: {vision: false, audio: false, video: false},
    canReason: null,
    raw: {},
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({name: 'shot.png', mimeType: 'image/png', bytes: Buffer.from('png')}),
    );
    // Refused when the image is chosen, not when the message is sent.
    assert.equal(response.statusCode, 400);
    const {error} = response.json<{error: {code: string; message: string}}>();
    assert.equal(error.code, 'unsupported_attachment');
    assert.match(error.message, /cannot read images/);
  } finally {
    await app.close();
  }
});

test('an image is allowed for a model whose vision support is unproven', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Never Loaded',
  });
  await store.setActiveModel(model.id);

  const app = await createTestServer(paths);
  try {
    // `null` means llama.cpp has never reported props. The server never rejects
    // on a guess; the user can simply load the model.
    const response = await app.inject(
      uploadRequest({name: 'shot.png', mimeType: 'image/png', bytes: Buffer.from('png')}),
    );
    assert.equal(response.statusCode, 201);
    assert.equal(response.json<{kind: string}>().kind, 'image');
  } finally {
    await app.close();
  }
});

test('a file over the per-file limit is refused with a coded error, not a raw 413', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject(
      uploadRequest({
        name: 'big.txt',
        bytes: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1024, 'a'),
      }),
    );
    // The parser aborts the stream, so the bytes are never buffered. The status
    // is the honest one, but the body still carries a code to branch on.
    assert.equal(response.statusCode, 413);
    const {error} = response.json<{error: {code: string; message: string}}>();
    assert.equal(error.code, 'unsupported_attachment');
    assert.match(error.message, /limited to 25 MiB per file/);
  } finally {
    await app.close();
  }
});

test('an unsent upload can be dropped, and dropping it twice is a 404', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const created = (
      await app.inject(uploadRequest({name: 'a.txt', bytes: Buffer.from('a')}))
    ).json<{uploadId: string}>();

    const deleted = await app.inject({method: 'DELETE', url: `/api/uploads/${created.uploadId}`});
    assert.equal(deleted.statusCode, 200);
    await assert.rejects(
      () => fs.stat(path.join(paths.uploadsDir, created.uploadId)),
      'the bytes go with the row',
    );

    const again = await app.inject({method: 'DELETE', url: `/api/uploads/${created.uploadId}`});
    assert.equal(again.statusCode, 404);
    assert.equal(again.json<{error: {code: string}}>().error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('an unknown upload id is a 404, not a crash', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const response = await app.inject({method: 'GET', url: '/api/uploads/nope'});
    assert.equal(response.statusCode, 404);
    assert.equal(response.json<{error: {code: string}}>().error.code, 'not_found');
  } finally {
    await app.close();
  }
});

test('an upload can be bound to the conversation that will send it', async () => {
  const paths = await createTempPaths();
  const app = await createTestServer(paths);
  try {
    const created = (
      await app.inject(
        uploadRequest({name: 'a.txt', bytes: Buffer.from('a'), conversationId: 'conv-1'}),
      )
    ).json<{uploadId: string}>();

    const database = new AppDatabase(paths);
    await database.open();
    try {
      const row = database.connection
        .prepare('SELECT conversation_id FROM uploads WHERE id = ?')
        .get(created.uploadId) as {conversation_id: string};
      assert.equal(row.conversation_id, 'conv-1');
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});

function uploadRequest(input: {
  name: string;
  bytes: Buffer;
  mimeType?: string;
  conversationId?: string;
}) {
  const parts: Buffer[] = [];
  if (input.conversationId) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="conversationId"\r\n\r\n${input.conversationId}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${input.name}"\r\n` +
        `Content-Type: ${input.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
    ),
    input.bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  );
  return {
    method: 'POST' as const,
    url: '/api/uploads',
    headers: {'content-type': `multipart/form-data; boundary=${BOUNDARY}`},
    payload: Buffer.concat(parts),
  };
}

test('an image is gated on the CONVERSATION model, not the global one', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const textOnly = await store.addHuggingFaceModel({
    repoId: 'repo/text',
    quant: 'UD-Q4_K_M',
    name: 'Text Only',
  });
  const vision = await store.addHuggingFaceModel({
    repoId: 'repo/vision',
    quant: 'UD-Q4_K_M',
    name: 'Vision',
  });
  // The GLOBAL model is the one that cannot see. Before this fix that was the only
  // model the upload route ever asked about, so an image attached to a chat pinned to a
  // vision model was refused -- and the mirror case let through an image the answering
  // model could not see.
  await store.setActiveModel(textOnly.id);

  const database = new AppDatabase(paths);
  await database.open();
  const cache = new ModelCacheRepository(database);
  cache.upsertModelProps(textOnly.id, {
    modelId: textOnly.id,
    modalities: {vision: false, audio: false, video: false},
    canReason: null,
    raw: {},
  });
  cache.upsertModelProps(vision.id, {
    modelId: vision.id,
    modalities: {vision: true, audio: false, video: false},
    canReason: null,
    raw: {},
  });
  const conversations = new ConversationRepository(database);
  await conversations.init();
  const seeing = conversations.createConversation({
    title: 'Pinned to a vision model',
    defaultModelId: vision.id,
  });
  const blind = conversations.createConversation({
    title: 'Pinned to a text-only model',
    defaultModelId: textOnly.id,
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    const accepted = await app.inject(
      uploadRequest({
        name: 'shot.png',
        mimeType: 'image/png',
        bytes: Buffer.from('png'),
        conversationId: seeing.id,
      }),
    );
    assert.equal(accepted.statusCode, 201, 'a vision chat must take an image');
    assert.equal(accepted.json<{kind: string}>().kind, 'image');

    // And the conversation's model still refuses when it is the one proven blind, even
    // though the model that can see is now globally active.
    await store.setActiveModel(vision.id);
    const refused = await app.inject(
      uploadRequest({
        name: 'shot.png',
        mimeType: 'image/png',
        bytes: Buffer.from('png'),
        conversationId: blind.id,
      }),
    );
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json<{error: {code: string}}>().error.code, 'unsupported_attachment');
  } finally {
    await app.close();
  }
});

test('an upload with no conversation still falls back to the active model', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const textOnly = await store.addHuggingFaceModel({
    repoId: 'repo/text',
    quant: 'UD-Q4_K_M',
    name: 'Text Only',
  });
  await store.setActiveModel(textOnly.id);

  const database = new AppDatabase(paths);
  await database.open();
  new ModelCacheRepository(database).upsertModelProps(textOnly.id, {
    modelId: textOnly.id,
    modalities: {vision: false, audio: false, video: false},
    canReason: null,
    raw: {},
  });
  database.close();

  const app = await createTestServer(paths);
  try {
    // No `conversationId` in the form -- there is no conversation to ask about, so the
    // global default is the honest thing to gate on.
    const response = await app.inject(
      uploadRequest({name: 'shot.png', mimeType: 'image/png', bytes: Buffer.from('png')}),
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.json<{error: {code: string}}>().error.code, 'unsupported_attachment');
  } finally {
    await app.close();
  }
});
