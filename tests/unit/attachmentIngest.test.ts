import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPdfText,
  ingestUpload,
  renderPdfPages,
  resolveChatAttachments,
  UnsupportedAttachmentError,
  type UploadReader,
} from '../../apps/server/src/attachmentIngest.ts';
import type {Upload} from '../../apps/server/src/uploads.ts';
import {ATTACHMENT_LIMITS} from '../../packages/shared/src/attachments.ts';
import {multiPagePdfBuffer, simplePdfBuffer} from './helpers/pdf.ts';

test('a text file is classified, read, and kept', async () => {
  const result = await ingestUpload({
    name: 'notes.md',
    mimeType: 'text/markdown',
    bytes: Buffer.from('# Title\n\nBody'),
  });
  assert.equal(result.kind, 'text');
  assert.equal(result.textContent, '# Title\n\nBody');
  assert.deepEqual(result.warnings, []);
});

test('a binary file posing as text is refused', async () => {
  // The NUL byte is the tell. The browser used to make this call.
  await assert.rejects(
    () => ingestUpload({name: 'a.txt', bytes: Buffer.from([0x68, 0x00, 0x69])}),
    UnsupportedAttachmentError,
  );
  await assert.rejects(
    () => ingestUpload({name: 'a.txt', bytes: Buffer.from([0x68, 0x00, 0x69])}),
    /looks like a binary file/,
  );
});

test('an empty text file is refused rather than sent as an empty prompt', async () => {
  await assert.rejects(() => ingestUpload({name: 'a.txt', bytes: Buffer.from('   ')}), /is empty/);
});

test('an unsupported file type is refused by name and type', async () => {
  await assert.rejects(
    () => ingestUpload({name: 'clip.mp4', mimeType: 'video/mp4', bytes: Buffer.from('x')}),
    /not a supported text, PDF, or image attachment/,
  );
});

test('a file over the per-file limit is refused before it is parsed', async () => {
  const bytes = Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1);
  await assert.rejects(() => ingestUpload({name: 'big.txt', bytes}), /larger than 25 MiB/);
});

test('long text is truncated, and the truncation is reported', async () => {
  const bytes = Buffer.from('a'.repeat(ATTACHMENT_LIMITS.maxTextCharacters + 100));
  const result = await ingestUpload({name: 'long.txt', bytes});
  assert.equal(result.textContent?.length, ATTACHMENT_LIMITS.maxTextCharacters);
  assert.match(result.warnings[0] ?? '', /truncated to 200,000 characters/);
});

test('an image keeps its bytes and needs no text', async () => {
  const result = await ingestUpload({
    name: 'shot.png',
    mimeType: 'image/png',
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  });
  assert.equal(result.kind, 'image');
  assert.equal(result.textContent, undefined);
  assert.equal(result.bytes.byteLength, 4);
});

test('a PDF is classified and its text extracted on the server', async () => {
  const result = await ingestUpload({
    name: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: simplePdfBuffer('Quarterly revenue rose'),
  });
  assert.equal(result.kind, 'pdf');
  assert.match(result.textContent ?? '', /Quarterly revenue rose/);
  assert.equal(result.pageCount, 1);
  // The original bytes are kept, so the same upload can be rendered later.
  assert.ok(result.bytes.byteLength > 0);
});

test('a PDF with no extractable text is refused rather than sent empty', async () => {
  await assert.rejects(
    () => ingestUpload({name: 'blank.pdf', bytes: simplePdfBuffer('')}),
    /did not contain extractable text/,
  );
});

test('extractPdfText reports the page count it walked', async () => {
  const extracted = await extractPdfText(simplePdfBuffer('one page'));
  assert.equal(extracted.pageCount, 1);
  assert.equal(extracted.truncated, false);
  assert.match(extracted.text, /one page/);
});

test('a PDF renders to a real PNG, on white paper', async () => {
  const {pages, skippedPages} = await renderPdfPages(simplePdfBuffer('Rendered'), {
    name: 'report.pdf',
    maxPages: 20,
  });
  assert.equal(pages.length, 1);
  assert.equal(skippedPages, 0);
  assert.equal(pages[0].name, 'report page 1.png');
  assert.equal(pages[0].mimeType, 'image/png');

  const png = Buffer.from(pages[0].data, 'base64');
  // The bare base64 must decode to a PNG, not to a data URL.
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(pages[0].sizeBytes, png.byteLength);
  assert.ok(png.byteLength > 100);

  const {createCanvas, loadImage} = await import('@napi-rs/canvas');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;

  // A PDF page is paper. A transparent page reaches the model as black.
  const [red, green, blue, alpha] = pixels.slice(0, 4);
  assert.deepEqual([red, green, blue, alpha], [255, 255, 255, 255], 'the corner is opaque white');

  // And the glyphs are actually drawn, rather than the page being blank.
  let darkPixels = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] < 128) {
      darkPixels += 1;
    }
  }
  assert.ok(darkPixels > 100, `expected rendered glyphs, saw ${darkPixels} dark pixels`);
});

test('rendering stops at the caller remaining slots, and says what it skipped', async () => {
  const {pages, skippedPages} = await renderPdfPages(simplePdfBuffer('One page only'), {
    name: 'report.pdf',
    maxPages: 1,
  });
  assert.equal(pages.length, 1);
  assert.equal(skippedPages, 0);
});

test('rendering with no slots left is refused, not silently skipped', async () => {
  await assert.rejects(
    () => renderPdfPages(simplePdfBuffer('x'), {name: 'a.pdf', maxPages: 0}),
    /Attach at most 20 files per message/,
  );
});

/** An in-memory upload store, so the resolver can be tested without a database. */
function uploadReader(uploads: Array<Partial<Upload> & {id: string; bytes: Buffer}>): UploadReader {
  const byId = new Map(uploads.map(upload => [upload.id, upload]));
  return {
    get(id) {
      const upload = byId.get(id);
      if (!upload) {
        return null;
      }
      return {
        id: upload.id,
        kind: upload.kind ?? 'text',
        name: upload.name ?? 'a.txt',
        mimeType: upload.mimeType,
        sizeBytes: upload.bytes.byteLength,
        storagePath: `uploads/${upload.id}/content`,
        textContent: upload.textContent,
        createdAt: '2026-07-09T00:00:00.000Z',
        boundAt: upload.boundAt,
      };
    },
    async readBytes(upload) {
      return byId.get(upload.id)!.bytes;
    },
  };
}

test('a text upload resolves to the text the server already extracted', async () => {
  const reader = uploadReader([
    {id: 'u1', kind: 'text', name: 'notes.md', bytes: Buffer.from('hello'), textContent: 'hello'},
  ]);
  const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'u1'}]);
  assert.deepEqual(attachments, [
    {id: 'u1', kind: 'text', name: 'notes.md', mimeType: undefined, sizeBytes: 5, text: 'hello'},
  ]);
});

test('an image upload resolves to bare base64, not a data URL', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const reader = uploadReader([
    {id: 'u1', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes},
  ]);
  const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'u1'}]);
  assert.equal(attachments[0].data, bytes.toString('base64'));
  assert.equal(attachments[0].kind, 'image');
});

test('a PDF resolves to its text, or to page images when asked', async () => {
  const bytes = simplePdfBuffer('Rendered page');
  const reader = uploadReader([
    {id: 'u1', kind: 'pdf', name: 'report.pdf', bytes, textContent: 'Rendered page'},
  ]);

  const asText = await resolveChatAttachments(reader, [{uploadId: 'u1'}]);
  assert.equal(asText.attachments[0].kind, 'pdf');
  assert.equal(asText.attachments[0].text, 'Rendered page');

  const asImages = await resolveChatAttachments(reader, [
    {uploadId: 'u1', renderPdfAsImages: true},
  ]);
  assert.equal(asImages.attachments.length, 1);
  assert.equal(asImages.attachments[0].kind, 'image');
  assert.equal(asImages.attachments[0].name, 'report page 1.png');
  assert.equal(asImages.attachments[0].id, 'u1:page-1');
  assert.equal(
    Buffer.from(asImages.attachments[0].data ?? '', 'base64')
      .subarray(1, 4)
      .toString(),
    'PNG',
  );
});

test('a missing upload is named, so the user knows to attach it again', async () => {
  await assert.rejects(
    () => resolveChatAttachments(uploadReader([]), [{uploadId: 'gone'}]),
    /gone is no longer available/,
  );
  await assert.rejects(
    () => resolveChatAttachments(uploadReader([]), [{uploadId: 'gone'}]),
    UnsupportedAttachmentError,
  );
});

test('a refusal carries the code a stream needs to report it', async () => {
  const error = await resolveChatAttachments(uploadReader([]), [{uploadId: 'gone'}]).catch(e => e);
  assert.equal((error as {code: string}).code, 'unsupported_attachment');
  assert.equal((error as {retryable: boolean}).retryable, false);
});

test('the per-message file cap counts rendered PDF pages, not references', async () => {
  // Nineteen text files plus a three-page PDF rendered as images: only one slot
  // is left, so the PDF may contribute one page and no more.
  const uploads = Array.from({length: 19}, (_, index) => ({
    id: `t${index}`,
    kind: 'text' as const,
    name: `f${index}.txt`,
    bytes: Buffer.from('x'),
    textContent: 'x',
  }));
  const reader = uploadReader([
    ...uploads,
    {
      id: 'pdf',
      kind: 'pdf',
      name: 'r.pdf',
      bytes: multiPagePdfBuffer(['one', 'two', 'three']),
      textContent: 'one two three',
    },
  ]);
  const {attachments, warnings} = await resolveChatAttachments(reader, [
    ...uploads.map(upload => ({uploadId: upload.id})),
    {uploadId: 'pdf', renderPdfAsImages: true},
  ]);
  assert.equal(attachments.length, 20);
  assert.equal(attachments.at(-1)?.name, 'r page 1.png');
  // Dropping two pages silently would read as "the model saw the whole document".
  assert.match(warnings[0] ?? '', /r\.pdf was rendered as 1 page; 2 pages skipped/);
});

test('a PDF rendered alone gets every page, up to the render cap', async () => {
  const reader = uploadReader([
    {
      id: 'pdf',
      kind: 'pdf',
      name: 'r.pdf',
      bytes: multiPagePdfBuffer(['one', 'two', 'three']),
      textContent: 'one two three',
    },
  ]);
  const {attachments, warnings} = await resolveChatAttachments(reader, [
    {uploadId: 'pdf', renderPdfAsImages: true},
  ]);
  assert.deepEqual(
    attachments.map(attachment => attachment.name),
    ['r page 1.png', 'r page 2.png', 'r page 3.png'],
  );
  assert.deepEqual(warnings, []);
});

test('a message past the total byte cap is refused', async () => {
  const big = Buffer.alloc(60 * 1024 * 1024, 1);
  const reader = uploadReader([
    {id: 'a', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes: big},
    {id: 'b', kind: 'image', name: 'b.png', mimeType: 'image/png', bytes: big},
  ]);
  await assert.rejects(
    () => resolveChatAttachments(reader, [{uploadId: 'a'}, {uploadId: 'b'}]),
    /limited to 100 MiB per message/,
  );
});
