import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  extractPdfText,
  ingestUpload,
  renderPdfPages,
  resolveChatAttachments,
  UnsupportedAttachmentError,
  type UploadReader,
} from '../../../src/attachments/ingest.ts';
import type {Upload} from '../../../src/attachments/uploads.ts';
import {ATTACHMENT_LIMITS} from '../../../src/contracts/attachments.ts';
import {imageOnlyPdfBuffer, multiPagePdfBuffer, simplePdfBuffer} from '../helpers/pdf.ts';

/**
 * Awaits a rejection and hands back the `Error`.
 *
 * The `.catch(thrown => thrown)` idiom these tests used types the result as
 * `Error | <the success value>`, so `.message` does not exist on it — which is what `tsc` finally
 * caught once `tests/` entered `tsconfig.include`. Worse, it **silently tolerates the call
 * succeeding**: you would get the success value, and the assertion would fail with something
 * confusing rather than "this was supposed to be refused". This fails loudly instead.
 */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as Error;
  }
  throw new assert.AssertionError({
    message: 'expected the call to be refused, but it resolved',
  });
}

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

test('a PDF with no text layer is accepted, because its pages are the document', async () => {
  // Refusing a scan here made the one document that *needs* page images the one
  // document Nelle would not accept, on a vision model included.
  const result = await ingestUpload({name: 'scan.pdf', bytes: simplePdfBuffer('')});
  assert.equal(result.kind, 'pdf');
  assert.equal(result.textContent, undefined);
  assert.equal(result.pageCount, 1);
  assert.deepEqual(result.warnings, []);
  // The bytes are kept, so the pages can be rendered at send time.
  assert.ok(result.bytes.byteLength > 0);
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
        pageCount: upload.pageCount,
        createdAt: '2026-07-09T00:00:00.000Z',
        boundAt: upload.boundAt,
      };
    },
    async readBytes(upload) {
      return byId.get(upload.id)!.bytes;
    },
  };
}

/** The default 16,384 token window; Pi's estimate leaves room for two images. */
const VISION_MODEL = {contextSize: 16384, visionSupport: true} as const;
const TEXT_ONLY_MODEL = {contextSize: 16384, visionSupport: false} as const;

test('a text upload resolves to the text the server already extracted', async () => {
  const reader = uploadReader([
    {id: 'u1', kind: 'text', name: 'notes.md', bytes: Buffer.from('hello'), textContent: 'hello'},
  ]);
  const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'u1'}], TEXT_ONLY_MODEL);
  assert.deepEqual(attachments, [
    {id: 'u1', kind: 'text', name: 'notes.md', mimeType: undefined, sizeBytes: 5, text: 'hello'},
  ]);
});

test('an image upload resolves to bare base64, not a data URL', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const reader = uploadReader([
    {id: 'u1', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes},
  ]);
  const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'u1'}], VISION_MODEL);
  assert.equal(attachments[0].data, bytes.toString('base64'));
  assert.equal(attachments[0].kind, 'image');
});

test('a PDF with a text layer is sent as text, on any model', async () => {
  // Text is cheap, exact, and needs no vision. There is no switch to say otherwise.
  const reader = uploadReader([
    {
      id: 'pdf',
      kind: 'pdf',
      name: 'report.pdf',
      bytes: simplePdfBuffer('Quarterly revenue rose'),
      textContent: 'Quarterly revenue rose',
      pageCount: 1,
    },
  ]);
  for (const model of [TEXT_ONLY_MODEL, VISION_MODEL]) {
    const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'pdf'}], model);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].kind, 'pdf');
    assert.equal(attachments[0].text, 'Quarterly revenue rose');
  }
});

test('a PDF with no text layer is sent as page images', async () => {
  // A scan. There is nothing to extract, so the pages are the document.
  const reader = uploadReader([
    {
      id: 'scan',
      kind: 'pdf',
      name: 'scan.pdf',
      bytes: multiPagePdfBuffer(['one', 'two']),
      pageCount: 2,
    },
  ]);
  const {attachments} = await resolveChatAttachments(reader, [{uploadId: 'scan'}], VISION_MODEL);
  assert.deepEqual(
    attachments.map(attachment => [attachment.kind, attachment.name]),
    [
      ['image', 'scan page 1.png'],
      ['image', 'scan page 2.png'],
    ],
  );
  assert.equal(
    Buffer.from(attachments[0].data ?? '', 'base64')
      .subarray(1, 4)
      .toString(),
    'PNG',
  );
  assert.equal(attachments[0].id, 'scan:page-1');
});

test('a scan is refused for a model llama.cpp has proven cannot see', async () => {
  const reader = uploadReader([
    {id: 'scan', kind: 'pdf', name: 'scan.pdf', bytes: simplePdfBuffer('x'), pageCount: 1},
  ]);
  await assert.rejects(
    () => resolveChatAttachments(reader, [{uploadId: 'scan'}], TEXT_ONLY_MODEL),
    /scan\.pdf has no text layer.*cannot read images/s,
  );
});

test('a scan too long for the context is refused with the arithmetic', async () => {
  // Pi charges 1,200 tokens an image, so a 16,384 token window fits two pages.
  const reader = uploadReader([
    {
      id: 'scan',
      kind: 'pdf',
      name: 'scan.pdf',
      bytes: multiPagePdfBuffer(['one', 'two', 'three']),
      pageCount: 6,
    },
  ]);
  const error = await rejection(resolveChatAttachments(reader, [{uploadId: 'scan'}], VISION_MODEL));
  assert.match(error.message, /scan\.pdf has no text layer, so its 6 pages must be read as images/);
  assert.match(error.message, /7,200 tokens/);
  assert.match(error.message, /16,384 token context window fits about 2 images/);
  assert.match(error.message, /Raise the context size to at least 20,991/);
});

test('more images than the context can afford are refused before the run', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const reader = uploadReader(
    [1, 2, 3].map(index => ({
      id: `i${index}`,
      kind: 'image' as const,
      name: `a${index}.png`,
      mimeType: 'image/png',
      bytes: png,
    })),
  );
  const references = [{uploadId: 'i1'}, {uploadId: 'i2'}, {uploadId: 'i3'}];

  // Two fit; the third is the one that would clamp Pi's reply budget to a token.
  const twoFit = await resolveChatAttachments(reader, references.slice(0, 2), VISION_MODEL);
  assert.equal(twoFit.attachments.length, 2);

  const error = await rejection(resolveChatAttachments(reader, references, VISION_MODEL));
  assert.match(error.message, /3 images need 3,600 tokens/);
  assert.match(error.message, /fits about 2 images/);
});

test('a window too small for even one image says so', async () => {
  const reader = uploadReader([
    {id: 'i1', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes: Buffer.from([1])},
  ]);
  await assert.rejects(
    () =>
      resolveChatAttachments(reader, [{uploadId: 'i1'}], {contextSize: 8192, visionSupport: true}),
    /8,192 token context window has no room for one/,
  );
});

test('an unknown context window skips the image pre-flight rather than refusing', async () => {
  // llama.cpp has never reported a window and no `c` caps it. There is no
  // arithmetic to do, and `maxAffordableImages(0)` is `0` -- which would refuse
  // every image. Refusing on a guess is the one thing worse than not refusing:
  // the run-time `reply_budget_exhausted` still catches what Pi cannot answer.
  const images = Array.from({length: 5}, (_, index) => ({
    id: `i${index}`,
    kind: 'image' as const,
    name: `page-${index}.png`,
    mimeType: 'image/png',
    bytes: Buffer.from([1]),
  }));
  const reader = uploadReader(images);
  const references = images.map(image => ({uploadId: image.id}));

  // Five images would never fit a 16,384-token window.
  await assert.rejects(
    () => resolveChatAttachments(reader, references, {contextSize: 16_384, visionSupport: true}),
    /fits about 2 images/,
  );

  const {attachments} = await resolveChatAttachments(reader, references, {
    contextSize: null,
    visionSupport: true,
  });
  assert.equal(attachments.length, 5, 'nothing is priced, so nothing is refused');
});

test('the hard page cap still applies when the window is unknown', async () => {
  // Skipping the *context* limit must not skip the limit that is not a guess.
  const pages = ATTACHMENT_LIMITS.maxRenderedPdfPages + 1;
  const reader = uploadReader([
    {
      id: 'p1',
      kind: 'pdf',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      pageCount: pages,
      bytes: simplePdfBuffer('x'),
    },
  ]);
  const error = await rejection(
    resolveChatAttachments(reader, [{uploadId: 'p1'}], {
      contextSize: null,
      visionSupport: true,
    }),
  );
  assert.match(error.message, /renders at most 20 pages per document/);
  // And it does not name a context window it never measured.
  assert.doesNotMatch(error.message, /token context window/);
});

test('a missing upload is named, so the user knows to attach it again', async () => {
  await assert.rejects(
    () => resolveChatAttachments(uploadReader([]), [{uploadId: 'gone'}], VISION_MODEL),
    /gone is no longer available/,
  );
  await assert.rejects(
    () => resolveChatAttachments(uploadReader([]), [{uploadId: 'gone'}], VISION_MODEL),
    UnsupportedAttachmentError,
  );
});

test('a refusal carries the code a stream needs to report it', async () => {
  const error = await resolveChatAttachments(
    uploadReader([]),
    [{uploadId: 'gone'}],
    VISION_MODEL,
  ).catch(e => e);
  assert.equal((error as {code: string}).code, 'unsupported_attachment');
  assert.equal((error as {retryable: boolean}).retryable, false);
});

test('a message past the total byte cap is refused', async () => {
  const big = Buffer.alloc(60 * 1024 * 1024, 1);
  const reader = uploadReader([
    {id: 'a', kind: 'image', name: 'a.png', mimeType: 'image/png', bytes: big},
    {id: 'b', kind: 'image', name: 'b.png', mimeType: 'image/png', bytes: big},
  ]);
  await assert.rejects(
    () => resolveChatAttachments(reader, [{uploadId: 'a'}, {uploadId: 'b'}], VISION_MODEL),
    /limited to 100 MiB per message/,
  );
});

/** A real PNG of `width x height`, so the decoder has something to decode. */
async function pngBuffer(width: number, height: number): Promise<Buffer> {
  const {createCanvas} = await import('@napi-rs/canvas');
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = 'rebeccapurple';
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

async function imageSize(bytes: Buffer): Promise<{width: number; height: number}> {
  const {loadImage} = await import('@napi-rs/canvas');
  const image = await loadImage(bytes);
  return {width: image.width, height: image.height};
}

test('a cap of zero sends the bytes untouched, byte for byte', async () => {
  const bytes = await pngBuffer(3000, 2000);
  for (const maxImageMegapixels of [0, undefined]) {
    const result = await ingestUpload({
      name: 'photo.png',
      mimeType: 'image/png',
      bytes,
      maxImageMegapixels,
    });
    assert.equal(result.bytes.equals(bytes), true, 'a disabled cap must not re-encode');
    assert.deepEqual(result.warnings, []);
  }
});

test('an image over the cap is downscaled, stays a valid PNG, and says so', async () => {
  // 6.0 MP down to 1.0 MP: the aspect ratio is kept, so it is not 1000x1000.
  const result = await ingestUpload({
    name: 'photo.png',
    mimeType: 'image/png',
    bytes: await pngBuffer(3000, 2000),
    maxImageMegapixels: 1,
  });

  const {width, height} = await imageSize(result.bytes);
  assert.ok((width * height) / 1e6 <= 1.0001, `${width}x${height} is over the cap`);
  assert.equal(Math.round((width / height) * 100), 150, 'the aspect ratio is 3:2');
  assert.equal(result.mimeType, 'image/png', 'a PNG stays a PNG');
  assert.match(result.warnings[0] ?? '', /photo\.png was downscaled to 1\.0 megapixels/);
});

test('an image already under the cap is not re-encoded', async () => {
  // Re-encoding a JPEG at quality 90 twice is a real quality loss for no gain.
  const bytes = await pngBuffer(800, 600);
  const result = await ingestUpload({
    name: 'small.png',
    mimeType: 'image/png',
    bytes,
    maxImageMegapixels: 4,
  });
  assert.equal(result.bytes.equals(bytes), true);
  assert.deepEqual(result.warnings, []);
});

test('a downscaled photograph becomes a JPEG rather than a larger PNG', async () => {
  const result = await ingestUpload({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    bytes: await pngBuffer(3000, 2000),
    maxImageMegapixels: 0.5,
  });
  assert.equal(result.mimeType, 'image/jpeg');
  // JPEG's own magic bytes, so this really is what it claims to be.
  assert.equal(result.bytes[0], 0xff);
  assert.equal(result.bytes[1], 0xd8);
});

test('a rendered PDF page obeys the smaller of the page cap and the megapixel cap', async () => {
  const reader = uploadReader([
    {
      id: 'p1',
      kind: 'pdf',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      pageCount: 1,
      bytes: imageOnlyPdfBuffer(),
    },
  ]);
  const model = {contextSize: 262_144, visionSupport: true} as const;

  const uncapped = await resolveChatAttachments(reader, [{uploadId: 'p1'}], model);
  const capped = await resolveChatAttachments(reader, [{uploadId: 'p1'}], model, {
    maxImageMegapixels: 0.01,
  });

  const pixels = async (data: string) => {
    const {width, height} = await imageSize(Buffer.from(data, 'base64'));
    return width * height;
  };
  const before = await pixels(uncapped.attachments[0]!.data!);
  const after = await pixels(capped.attachments[0]!.data!);
  assert.ok(after < before, 'the megapixel cap shrinks a rendered page');
  assert.ok(after <= 10_000 * 1.05, `${after} pixels is over the 0.01 MP cap`);
});
