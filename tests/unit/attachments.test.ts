import assert from 'node:assert/strict';
import test from 'node:test';

// `readFileAsBase64` uses the browser's FileReader, which Node does not provide.
// The classification, gating and limit logic under test is otherwise pure.
class NodeFileReader {
  result: string | null = null;
  error: Error | null = null;
  #listeners = new Map<string, Array<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  readAsDataURL(file: Blob): void {
    void (async () => {
      try {
        const buffer = await file.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        this.result = `data:${file.type || 'application/octet-stream'};base64,${base64}`;
        for (const listener of this.#listeners.get('load') ?? []) {
          listener();
        }
      } catch (error) {
        this.error = error as Error;
        for (const listener of this.#listeners.get('error') ?? []) {
          listener();
        }
      }
    })();
  }
}

(globalThis as {FileReader?: unknown}).FileReader = NodeFileReader;

const {ATTACHMENT_LIMITS, getDraftAttachmentError, prepareDraftAttachments} =
  await import('../../apps/web/src/utils/attachments.ts');
const {chatRequestSchema} = await import('../../packages/shared/src/contracts.ts');

const textOnlyModel = {
  modelId: 'repo/model:Q4_K_M',
  modalities: {vision: false, audio: false, video: false},
  raw: {},
};
const visionModel = {
  modelId: 'repo/model:Q4_K_M',
  modalities: {vision: true, audio: false, video: false},
  raw: {},
};

function textFile(name: string, content: string): File {
  return new File([content], name, {type: 'text/plain'});
}

function imageFile(name = 'shot.png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, {type: 'image/png'});
}

test('text attachments are classified and their content extracted', async () => {
  const result = await prepareDraftAttachments([textFile('notes.txt', 'hello nelle')], {
    existing: [],
    canAttachImages: false,
    renderPdfImages: false,
  });

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.kind, 'text');
  assert.equal(result.attachments[0]?.text, 'hello nelle');
  assert.equal(result.warning, undefined);
});

test('binary-looking files are rejected rather than sent as text', async () => {
  // A NUL byte is what separates "a text file we can read" from "a blob that
  // would reach the model as mojibake".
  const binary = new File([new Uint8Array([0x00, 0x01, 0x02])], 'weights.bin', {
    type: 'text/plain',
  });

  await assert.rejects(
    () =>
      prepareDraftAttachments([binary], {
        existing: [],
        canAttachImages: false,
        renderPdfImages: false,
      }),
    /looks like a binary file|not a supported text/i,
  );
});

test('unsupported file types are refused by name and type', async () => {
  const audio = new File([new Uint8Array([1])], 'clip.mp3', {type: 'audio/mpeg'});

  await assert.rejects(
    () =>
      prepareDraftAttachments([audio], {
        existing: [],
        canAttachImages: true,
        renderPdfImages: false,
      }),
    /not a supported text, PDF, or image attachment/,
  );
});

test('long text is truncated with a visible warning rather than silently cut', async () => {
  const long = 'a'.repeat(ATTACHMENT_LIMITS.maxTextCharacters + 500);
  const result = await prepareDraftAttachments([textFile('long.txt', long)], {
    existing: [],
    canAttachImages: false,
    renderPdfImages: false,
  });

  assert.equal(result.attachments[0]?.text?.length, ATTACHMENT_LIMITS.maxTextCharacters);
  assert.match(result.warning ?? '', /truncated/i);
});

test('a file larger than the per-file limit is rejected before it is read', async () => {
  const oversized = textFile('big.txt', 'x');
  Object.defineProperty(oversized, 'size', {value: ATTACHMENT_LIMITS.maxFileBytes + 1});

  await assert.rejects(
    () =>
      prepareDraftAttachments([oversized], {
        existing: [],
        canAttachImages: false,
        renderPdfImages: false,
      }),
    /larger than/,
  );
});

test('the per-message file count is capped', async () => {
  const existing = Array.from({length: ATTACHMENT_LIMITS.maxFiles}, (_, index) => ({
    id: `existing-${index}`,
    kind: 'text' as const,
    name: `f${index}.txt`,
    sizeBytes: 1,
  }));

  await assert.rejects(
    () =>
      prepareDraftAttachments([textFile('one-too-many.txt', 'x')], {
        existing,
        canAttachImages: false,
        renderPdfImages: false,
      }),
    new RegExp(`at most ${ATTACHMENT_LIMITS.maxFiles} files`),
  );
});

test('the total draft payload is capped across files', async () => {
  // Each file is under the 25 MiB per-file cap; five of them are over the
  // 100 MiB per-message one. Only the running total can catch this.
  const files = Array.from({length: 5}, (_, index) => {
    const file = textFile(`part-${index}.txt`, 'x');
    Object.defineProperty(file, 'size', {value: ATTACHMENT_LIMITS.maxFileBytes - 1});
    return file;
  });

  await assert.rejects(
    () =>
      prepareDraftAttachments(files, {
        existing: [],
        canAttachImages: false,
        renderPdfImages: false,
      }),
    /limited to/,
  );
});

test('images need a vision model, and are base64-normalized once they have one', async () => {
  await assert.rejects(
    () =>
      prepareDraftAttachments([imageFile()], {
        existing: [],
        canAttachImages: false,
        renderPdfImages: false,
      }),
    /require a selected model with vision support/,
  );

  const allowed = await prepareDraftAttachments([imageFile()], {
    existing: [],
    canAttachImages: true,
    renderPdfImages: false,
  });
  assert.equal(allowed.attachments[0]?.kind, 'image');
  assert.equal(allowed.attachments[0]?.mimeType, 'image/png');
  // Bare base64, not a data URL: the data URL prefix is stripped on read.
  assert.equal(allowed.attachments[0]?.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('pending images are revalidated when the selected model changes', async () => {
  const pendingImage = [
    {id: 'a1', kind: 'image' as const, name: 'shot.png', sizeBytes: 3, data: 'data:image/png;'},
  ];

  assert.equal(getDraftAttachmentError(pendingImage, visionModel), null);
  assert.match(
    getDraftAttachmentError(pendingImage, textOnlyModel) ?? '',
    /cannot read image attachments|vision/i,
  );
  // The composer is conservative where the server is not: llama.cpp has never
  // reported props, so the UI keeps images blocked until the model is loaded,
  // while the chat route refuses to reject a model it cannot disprove.
  assert.match(getDraftAttachmentError(pendingImage, null) ?? '', /vision support/i);
});

test('the composer and the chat schema agree on every attachment limit', () => {
  // The composer used to allow 20 files while chatRequestSchema capped the array
  // at 10, so the eleventh came back as an HTTP 500 carrying a zod dump.
  const attachment = (index: number) => ({
    id: `a${index}`,
    kind: 'text' as const,
    name: `f${index}.txt`,
    text: 'hello',
  });

  const atLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles}, (_, i) => attachment(i)),
  });
  assert.equal(atLimit.success, true, 'the composer maximum must be acceptable to the server');

  const overLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles + 1}, (_, i) => attachment(i)),
  });
  assert.equal(overLimit.success, false);
  assert.match(
    overLimit.error?.issues[0]?.message ?? '',
    /Attach at most 20 files per message/,
    'and one file past it must say so in words',
  );

  // Per-file and per-message byte caps, and the text cap, come from the same const.
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{...attachment(0), sizeBytes: ATTACHMENT_LIMITS.maxFileBytes + 1}],
    }).success,
    false,
  );
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{...attachment(0), text: 'a'.repeat(ATTACHMENT_LIMITS.maxTextCharacters + 1)}],
    }).success,
    false,
  );
});
