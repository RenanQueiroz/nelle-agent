import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPdfText,
  ingestUpload,
  renderPdfPages,
  UnsupportedAttachmentError,
} from '../../apps/server/src/attachmentIngest.ts';
import {ATTACHMENT_LIMITS} from '../../packages/shared/src/attachments.ts';
import {simplePdfBuffer} from './helpers/pdf.ts';

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
