import assert from 'node:assert/strict';
import test, {afterEach} from 'node:test';

import {ATTACHMENT_LIMITS} from '../../packages/shared/src/attachments.ts';
import {chatRequestSchema} from '../../packages/shared/src/contracts.ts';
import {
  getDraftAttachmentError,
  prepareDraftAttachments,
} from '../../apps/web/src/utils/attachments.ts';
import type {DraftAttachment} from '../../apps/web/src/types.ts';

/**
 * The browser no longer classifies, extracts, or renders anything: it posts the
 * bytes and keeps the reference. What is left to test here is what it still
 * decides -- refusing a file before spending a round trip on it, and refusing an
 * image for a model that cannot be shown to read one.
 */
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type UploadCall = {url: string; method: string};

function mockUploads(options: {sizeBytes?: number; warnings?: string[]} = {}): UploadCall[] {
  const calls: UploadCall[] = [];
  let nextId = 0;
  globalThis.fetch = (async (input: unknown, init?: {method?: string}) => {
    const url = String(input);
    const method = init?.method ?? 'POST';
    calls.push({url, method});
    if (method === 'DELETE') {
      return new Response(JSON.stringify({ok: true}), {status: 200});
    }
    nextId += 1;
    return new Response(
      JSON.stringify({
        uploadId: `upload-${nextId}`,
        kind: 'text',
        name: `f${nextId}.txt`,
        mimeType: 'text/plain',
        sizeBytes: options.sizeBytes ?? 5,
        warnings: options.warnings ?? [],
      }),
      {status: 201, headers: {'content-type': 'application/json'}},
    );
  }) as typeof fetch;
  return calls;
}

function textFile(name: string, content = 'hello nelle'): File {
  return new File([content], name, {type: 'text/plain'});
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, {type: 'image/png'});
}

test('a picked file is uploaded, and the draft keeps only the reference', async () => {
  const calls = mockUploads();
  const result = await prepareDraftAttachments([textFile('notes.txt')], {
    existing: [],
    canAttachImages: false,
    conversationId: 'conv-1',
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/uploads$/);
  assert.deepEqual(result.attachments, [
    {
      uploadId: 'upload-1',
      kind: 'text',
      name: 'f1.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      pageCount: undefined,
      hasTextLayer: undefined,
    },
  ]);
  // No `text`, no `data`: the bytes stay on the server.
  assert.equal('text' in result.attachments[0], false);
  assert.equal('data' in result.attachments[0], false);
});

test('a server warning reaches the composer', async () => {
  mockUploads({warnings: ['notes.txt was truncated to 200,000 characters.']});
  const result = await prepareDraftAttachments([textFile('notes.txt')], {
    existing: [],
    canAttachImages: false,
  });
  assert.match(result.warning ?? '', /truncated to 200,000 characters/);
});

test('an oversized file is refused before a byte is uploaded', async () => {
  const calls = mockUploads();
  const huge = new File(['x'], 'big.bin', {type: 'text/plain'});
  Object.defineProperty(huge, 'size', {value: ATTACHMENT_LIMITS.maxFileBytes + 1});

  await assert.rejects(
    () => prepareDraftAttachments([huge], {existing: [], canAttachImages: false}),
    /larger than/,
  );
  assert.equal(calls.length, 0, 'no round trip is spent on a file the server will refuse');
});

test('the per-message file count is capped before uploading the twenty-first', async () => {
  const calls = mockUploads();
  const existing: DraftAttachment[] = Array.from(
    {length: ATTACHMENT_LIMITS.maxFiles},
    (_, index) => ({
      uploadId: `u${index}`,
      kind: 'text' as const,
      name: `f${index}.txt`,
      sizeBytes: 1,
    }),
  );
  await assert.rejects(
    () => prepareDraftAttachments([textFile('one-more.txt')], {existing, canAttachImages: false}),
    /Attach at most 20 files per message/,
  );
  assert.equal(calls.length, 0);
});

test('a draft past the byte cap drops the upload it just made', async () => {
  const calls = mockUploads({sizeBytes: ATTACHMENT_LIMITS.maxDraftBytes});
  const existing: DraftAttachment[] = [
    {uploadId: 'u0', kind: 'text', name: 'a.txt', sizeBytes: 1024},
  ];

  await assert.rejects(
    () => prepareDraftAttachments([textFile('big.txt')], {existing, canAttachImages: false}),
    /limited to 100 MiB per message/,
  );
  // The bytes reached the server, so they must not be left behind as a draft the
  // user can neither see nor delete.
  assert.deepEqual(
    calls.map(call => call.method),
    ['POST', 'DELETE'],
  );
  assert.match(calls[1].url, /\/api\/uploads\/upload-1$/);
});

test('an image is refused while the model cannot be shown to read one', async () => {
  const calls = mockUploads();
  await assert.rejects(
    () => prepareDraftAttachments([imageFile()], {existing: [], canAttachImages: false}),
    /vision support/i,
  );
  assert.equal(calls.length, 0);

  // With vision proven, the same file goes up.
  await prepareDraftAttachments([imageFile()], {existing: [], canAttachImages: true});
  assert.equal(calls.length, 1);
});

test('an image named without an extension is still gated on its MIME type', async () => {
  const calls = mockUploads();
  const pasted = new File([new Uint8Array([1])], 'pasted', {type: 'image/png'});
  await assert.rejects(
    () => prepareDraftAttachments([pasted], {existing: [], canAttachImages: false}),
    /vision support/i,
  );
  assert.equal(calls.length, 0);
});

test('the upload refusal the server sent is what the user reads', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {code: 'unsupported_attachment', message: 'a.txt looks like a binary file.'},
      }),
      {status: 400, headers: {'content-type': 'application/json'}},
    )) as typeof fetch;

  await assert.rejects(
    () => prepareDraftAttachments([textFile('a.txt')], {existing: [], canAttachImages: false}),
    /looks like a binary file/,
  );
});

test('the composer is conservative where the server refuses to guess', () => {
  const image: DraftAttachment[] = [{uploadId: 'u1', kind: 'image', name: 'a.png', sizeBytes: 1}];
  // llama.cpp has never reported props, so the UI keeps images blocked until the
  // model is loaded, while the chat route refuses to reject what it cannot disprove.
  assert.match(getDraftAttachmentError(image, false) ?? '', /vision support/i);
  assert.equal(getDraftAttachmentError(image, true), null);
  assert.equal(getDraftAttachmentError([], false), null);
});

test('the chat schema takes upload references, and still caps the file count', () => {
  // The composer used to allow 20 files while chatRequestSchema capped the array
  // at 10, so the eleventh came back as an HTTP 500 carrying a zod dump.
  const reference = (index: number) => ({uploadId: `upload-${index}`});

  const atLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles}, (_, i) => reference(i)),
  });
  assert.equal(atLimit.success, true, 'the composer maximum must be acceptable to the server');

  const overLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles + 1}, (_, i) => reference(i)),
  });
  assert.equal(overLimit.success, false);
  assert.match(
    overLimit.error?.issues[0]?.message ?? '',
    /Attach at most 20 files per message/,
    'and one file past it must say so in words',
  );

  // The bytes never travel with the message any more, and neither does a
  // rendering mode: the server decides that from the document. A client sending
  // either is talking to an older server, and must be told so.
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{uploadId: 'u1', kind: 'text', name: 'a.txt', text: 'hello'}],
    }).success,
    false,
  );
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{uploadId: 'u1', renderPdfAsImages: true}],
    }).success,
    false,
  );
  assert.equal(chatRequestSchema.safeParse({message: 'x', attachments: [{}]}).success, false);
});
