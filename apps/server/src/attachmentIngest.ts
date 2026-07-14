import {
  ATTACHMENT_LIMIT_MESSAGES,
  ATTACHMENT_LIMITS,
} from '../../../packages/shared/src/attachments.ts';
import {
  maxAffordableImages,
  minimumContextSizeForImages,
  PI_AGENT_PROMPT_TOKENS,
  PI_ESTIMATED_IMAGE_TOKENS,
} from '../../../packages/shared/src/piContext.ts';
import {
  ATTACHMENT_MESSAGES,
  classifyAttachment,
  dataUrlByteLength,
  isBinaryText,
  mimeTypeFromName,
  renderedPdfPageName,
  truncateAttachmentText,
  type AttachmentKind,
} from '../../../packages/shared/src/attachmentRules.ts';
import {NELLE_ERROR_CODES} from '../../../packages/shared/src/contracts.ts';
import type {
  ChatAttachmentInput,
  ChatAttachmentReference,
} from '../../../packages/shared/src/contracts.ts';
import type {Upload} from './uploads';

/**
 * Turning uploaded bytes into what a model can read: text extraction, PDF page
 * rendering, and image normalization.
 *
 * This ran in the browser, against `pdfjs-dist`, a DOM `canvas`, and a
 * `FileReader`. React Native has none of those, so the work moves here and the
 * client posts bytes.
 */

/** What `resolveChatAttachments` needs from the upload store. */
export type UploadReader = {
  get(id: string): Upload | null;
  readBytes(upload: Upload): Promise<Buffer>;
};

/** Rendered pages are capped on the long edge, as the browser capped them. */
const MAX_RENDERED_EDGE_PX = 1600;
const MAX_RENDER_SCALE = 2;
/** Re-encoding a JPEG at 90 twice is a real quality loss for no gain. */
const JPEG_QUALITY = 0.9;

/**
 * Shrinks an image above `maxMegapixels`, or returns `null` for "left alone".
 *
 * `null` for a cap of `0`, and `null` for an image already under it: an image
 * that needs no resizing is never re-encoded, because re-encoding a JPEG at
 * quality 90 twice loses quality and buys nothing.
 *
 * What this saves is bytes on the wire and prompt-processing work, **not**
 * context. gemma's vision encoder saturates near 0.8 MP -- 104/208/282/282/276
 * prompt tokens from 0.2 to 6.0 MP -- so a six-megapixel photo costs the same
 * context as a one-megapixel one. Other encoders tile rather than saturate, so
 * the saving is a property of the model, which is why this is off by default.
 */
async function downscaleImage(
  bytes: Buffer,
  mimeType: string,
  maxMegapixels: number,
): Promise<{bytes: Buffer; mimeType: string; megapixels: number} | null> {
  if (!(maxMegapixels > 0)) {
    return null;
  }
  const maxPixels = maxMegapixels * 1e6;
  const {createCanvas, loadImage} = await import('@napi-rs/canvas');
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    // A format `@napi-rs/canvas` will not decode. llama.cpp may still read it.
    return null;
  }
  const pixels = image.width * image.height;
  if (pixels <= maxPixels) {
    return null;
  }

  const scale = Math.sqrt(maxPixels / pixels);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0, width, height);

  // A resized PNG stays a PNG; anything else becomes a JPEG, because a
  // six-megapixel photograph as a PNG is larger than the file it replaced.
  const isPng = mimeType === 'image/png';
  return {
    bytes: isPng ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', JPEG_QUALITY),
    mimeType: isPng ? 'image/png' : 'image/jpeg',
    megapixels: (width * height) / 1e6,
  };
}

export type IngestedUpload = {
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  bytes: Buffer;
  /**
   * Extracted text for `text`, and for a `pdf` with a text layer. A scan has
   * none, and is read as page images instead.
   */
  textContent?: string;
  /** Pages a `pdf` holds, so a scan can be priced before it is rendered. */
  pageCount?: number;
  warnings: string[];
};

export type RenderedPdfPage = {
  name: string;
  mimeType: 'image/png';
  /** Bare base64, matching how images reach Pi. */
  data: string;
  sizeBytes: number;
};

/**
 * Classifies and reads an uploaded file. Throws with the message the user should
 * see; the route turns it into an `unsupported_attachment` error.
 */
export async function ingestUpload(input: {
  name: string;
  mimeType?: string;
  bytes: Buffer;
  /** `attachments.maxImageMegapixels`. `0` sends the bytes untouched. */
  maxImageMegapixels?: number;
}): Promise<IngestedUpload> {
  const {name, bytes} = input;
  if (bytes.byteLength > ATTACHMENT_LIMITS.maxFileBytes) {
    throw new UnsupportedAttachmentError(
      `${name} is larger than ${formatMebibytes(ATTACHMENT_LIMITS.maxFileBytes)}.`,
    );
  }
  const mimeType = input.mimeType || mimeTypeFromName(name) || '';
  const kind = classifyAttachment({name, mimeType});
  if (!kind) {
    throw new UnsupportedAttachmentError(ATTACHMENT_MESSAGES.unsupportedKind(name));
  }

  if (kind === 'image') {
    const resolved = mimeType || 'image/jpeg';
    const downscaled = await downscaleImage(bytes, resolved, input.maxImageMegapixels ?? 0);
    return {
      kind,
      name,
      mimeType: downscaled?.mimeType ?? resolved,
      bytes: downscaled?.bytes ?? bytes,
      warnings: downscaled ? [ATTACHMENT_MESSAGES.downscaled(name, downscaled.megapixels)] : [],
    };
  }

  if (kind === 'pdf') {
    const extracted = await extractPdfText(bytes);
    // A scan has no text layer. Refusing it here is what made the one document
    // that *needs* page images the one document Nelle would not accept.
    const hasTextLayer = extracted.text.trim().length > 0;
    return {
      kind,
      name,
      mimeType: mimeType || 'application/pdf',
      bytes,
      textContent: hasTextLayer ? extracted.text : undefined,
      pageCount: extracted.pageCount,
      warnings: hasTextLayer && extracted.truncated ? [ATTACHMENT_MESSAGES.truncated(name)] : [],
    };
  }

  const rawText = bytes.toString('utf8');
  if (isBinaryText(rawText)) {
    throw new UnsupportedAttachmentError(ATTACHMENT_MESSAGES.binaryFile(name));
  }
  const {text, truncated} = truncateAttachmentText(rawText);
  if (!text.trim()) {
    throw new UnsupportedAttachmentError(ATTACHMENT_MESSAGES.emptyFile(name));
  }
  return {
    kind,
    name,
    mimeType: mimeType || 'text/plain',
    bytes,
    textContent: text,
    warnings: truncated ? [ATTACHMENT_MESSAGES.truncated(name)] : [],
  };
}

export async function extractPdfText(
  bytes: Buffer,
): Promise<{text: string; truncated: boolean; pageCount: number}> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({data: toUint8Array(bytes)});
  const document = await task.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ');
      if (pageText) {
        pages.push(pageText);
      }
      const currentText = pages.join('\n\n');
      if (currentText.length >= ATTACHMENT_LIMITS.maxTextCharacters) {
        return {
          text: currentText.slice(0, ATTACHMENT_LIMITS.maxTextCharacters),
          truncated: true,
          pageCount: document.numPages,
        };
      }
    }
    return {text: pages.join('\n\n'), truncated: false, pageCount: document.numPages};
  } finally {
    await document.cleanup();
    await task.destroy();
  }
}

/**
 * Renders up to `maxPages` pages to PNG. `maxPages` is the caller's remaining
 * attachment slots, so a 30-page PDF cannot spend a message's whole budget.
 */
export async function renderPdfPages(
  bytes: Buffer,
  input: {name: string; maxPages: number; maxImageMegapixels?: number},
): Promise<{pages: RenderedPdfPage[]; skippedPages: number}> {
  const pageLimit = Math.min(input.maxPages, ATTACHMENT_LIMITS.maxRenderedPdfPages);
  if (pageLimit <= 0) {
    throw new UnsupportedAttachmentError(
      `Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`,
    );
  }

  const pdfjs = await loadPdfJs();
  const {createCanvas} = await import('@napi-rs/canvas');
  const task = pdfjs.getDocument({data: toUint8Array(bytes)});
  const document = await task.promise;
  const pages: RenderedPdfPage[] = [];
  try {
    const renderCount = Math.min(document.numPages, pageLimit);
    for (let pageNumber = 1; pageNumber <= renderCount; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const baseViewport = page.getViewport({scale: 1});
      // The long-edge cap and the megapixel cap both apply; the smaller wins.
      const megapixelScale =
        input.maxImageMegapixels && input.maxImageMegapixels > 0
          ? Math.sqrt((input.maxImageMegapixels * 1e6) / (baseViewport.width * baseViewport.height))
          : Number.POSITIVE_INFINITY;
      const scale = Math.min(
        MAX_RENDER_SCALE,
        MAX_RENDERED_EDGE_PX / Math.max(baseViewport.width, baseViewport.height),
        megapixelScale,
      );
      const viewport = page.getViewport({scale});
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const canvasContext = canvas.getContext('2d');
      // pdf.js paints the page background white by default, and the render test
      // asserts an opaque white corner. This makes that independent of a pdf.js
      // default, because a transparent page reaches the model as black.
      canvasContext.fillStyle = 'white';
      canvasContext.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({
        canvasContext: canvasContext as unknown as CanvasRenderingContext2D,
        canvas: canvas as unknown as HTMLCanvasElement,
        viewport,
      }).promise;
      const data = canvas.toBuffer('image/png').toString('base64');
      pages.push({
        name: renderedPdfPageName(input.name, pageNumber),
        mimeType: 'image/png',
        data,
        sizeBytes: dataUrlByteLength(data),
      });
      page.cleanup();
    }
    return {pages, skippedPages: document.numPages - renderCount};
  } finally {
    await document.cleanup();
    await task.destroy();
  }
}

/** A PDF with no text layer is a scan: page images are the only way to read it. */
export function pdfNeedsPageImages(upload: Upload): boolean {
  return upload.kind === 'pdf' && !upload.textContent?.trim();
}

/**
 * Expands upload references into the attachment inputs the harness understands,
 * deciding for each PDF whether the model should read its text or its pages.
 *
 * There is no switch. A PDF with a text layer is sent as text, which is cheap,
 * exact, and works on a model with no vision at all; a scan has no text to send,
 * so its pages are rendered. The per-message limits are enforced after that
 * expansion, because a six-page scan is six attachments.
 */
export async function resolveChatAttachments(
  uploads: UploadReader,
  references: ChatAttachmentReference[],
  model: {contextSize: number | null; visionSupport: boolean | null},
  options: {maxImageMegapixels?: number} = {},
): Promise<{attachments: ChatAttachmentInput[]}> {
  const resolved = references.map(reference => {
    const upload = uploads.get(reference.uploadId);
    if (!upload) {
      throw new UnsupportedAttachmentError(
        `Attachment ${reference.uploadId} is no longer available. Attach the file again.`,
      );
    }
    return upload;
  });

  const scans = resolved.filter(pdfNeedsPageImages);
  if (scans.length > 0 && model.visionSupport === false) {
    throw new UnsupportedAttachmentError(
      `${scans[0].name} has no text layer, so it can only be read as page images, and the ` +
        'selected model cannot read images. Choose a vision model.',
    );
  }

  // With no known window there is no arithmetic to do, so the context-derived
  // limit is skipped. `maxAffordableImages(0)` is `0`, which would refuse every
  // image, and refusing on a guess is the one thing worse than not refusing: a
  // run-time `reply_budget_exhausted` still catches a payload Pi cannot answer
  // within. The hard page cap is not a guess, so it still applies.
  const imageBudget =
    model.contextSize == null ? Number.POSITIVE_INFINITY : maxAffordableImages(model.contextSize);
  const pageBudget = Math.min(imageBudget, ATTACHMENT_LIMITS.maxRenderedPdfPages);
  for (const scan of scans) {
    const pages = scan.pageCount ?? 1;
    if (pages > pageBudget) {
      throw imageBudgetError({
        contextSize: model.contextSize,
        imageCount: pages,
        imageBudget,
        scanName: scan.name,
      });
    }
  }

  const imageCount =
    resolved.filter(upload => upload.kind === 'image').length +
    scans.reduce((sum, scan) => sum + (scan.pageCount ?? 1), 0);
  if (imageCount > imageBudget) {
    throw imageBudgetError({contextSize: model.contextSize, imageCount, imageBudget});
  }

  const attachments: ChatAttachmentInput[] = [];
  for (const upload of resolved) {
    if (pdfNeedsPageImages(upload)) {
      const rendered = await renderPdfPages(await uploads.readBytes(upload), {
        name: upload.name,
        maxPages: pageBudget,
        maxImageMegapixels: options.maxImageMegapixels,
      });
      for (const [index, page] of rendered.pages.entries()) {
        attachments.push({
          id: `${upload.id}:page-${index + 1}`,
          kind: 'image',
          name: page.name,
          mimeType: page.mimeType,
          sizeBytes: page.sizeBytes,
          data: page.data,
        });
      }
    } else if (upload.kind === 'image') {
      const bytes = await uploads.readBytes(upload);
      attachments.push({
        id: upload.id,
        kind: 'image',
        name: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        data: bytes.toString('base64'),
      });
    } else {
      attachments.push({
        id: upload.id,
        kind: upload.kind,
        name: upload.name,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        text: upload.textContent ?? '',
      });
    }

    if (attachments.length > ATTACHMENT_LIMITS.maxFiles) {
      throw new UnsupportedAttachmentError(ATTACHMENT_LIMIT_MESSAGES.tooManyFiles);
    }
    const totalBytes = attachments.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
    if (totalBytes > ATTACHMENT_LIMITS.maxDraftBytes) {
      throw new UnsupportedAttachmentError(ATTACHMENT_LIMIT_MESSAGES.draftTooLarge);
    }
  }

  return {attachments};
}

/**
 * Refuses a message whose images Pi could not leave room to answer, and shows
 * the arithmetic rather than letting the run die with a clamped reply budget.
 */
function imageBudgetError(input: {
  /** `null` when the window is unknown, so only the page cap can have refused. */
  contextSize: number | null;
  imageCount: number;
  imageBudget: number;
  scanName?: string;
}): UnsupportedAttachmentError {
  const tokens = (input.imageCount * PI_ESTIMATED_IMAGE_TOKENS).toLocaleString();
  const subject = input.scanName
    ? `${input.scanName} has no text layer, so its ${plural(input.imageCount, 'page')} must be ` +
      `read as images (${tokens} tokens)`
    : `${plural(input.imageCount, 'image')} need ${tokens} tokens`;

  // The window is unknown, so nothing was priced: only the hard page cap, which
  // is not a guess about context, could have refused this.
  if (input.contextSize == null) {
    return new UnsupportedAttachmentError(
      `${subject}. Nelle renders at most ` +
        `${plural(ATTACHMENT_LIMITS.maxRenderedPdfPages, 'page')} per document. Attach less.`,
    );
  }

  const needed = minimumContextSizeForImages(input.imageCount, PI_AGENT_PROMPT_TOKENS);
  // "about", because Pi's system prompt is not a fixed size: it was measured at
  // 9,439 tokens and observed 350 higher, which is a third of an image.
  const fits =
    input.imageBudget === 0
      ? 'has no room for one'
      : `fits about ${plural(input.imageBudget, 'image')}`;

  return new UnsupportedAttachmentError(
    `${subject}. This model's ${input.contextSize.toLocaleString()} token context window ` +
      `${fits}. Raise the context size to at least ${needed.toLocaleString()} in ` +
      'Settings > Models, or attach less.',
  );
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

export class UnsupportedAttachmentError extends Error {
  /** Read by `createErrorEvent`, so a refusal keeps its code onto the stream. */
  readonly code = NELLE_ERROR_CODES.unsupportedAttachment;
  readonly retryable = false;
}

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfJsPromise: Promise<PdfJsModule> | null = null;

/**
 * The legacy build is the one that runs without a DOM. Loaded lazily so a server
 * that never sees a PDF never pays for it.
 *
 * **The globals are ours to install, and in a compiled binary nobody else can.** pdfjs needs
 * `DOMMatrix`, and it tries to get it itself, like this (`display/node_utils.js`):
 *
 * ```js
 * const require = process.getBuiltinModule("module").createRequire(import.meta.url);
 * canvas = require("@napi-rs/canvas");          // <- fails inside `bun build --compile`
 * if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
 * ```
 *
 * `createRequire(import.meta.url)` resolves against the *module's own path*, and in a compiled
 * binary that path is inside Bun's virtual bundle — so the require fails, `DOMMatrix` is never
 * set, and every PDF dies with `DOMMatrix is not defined`. Running from source it works, which
 * is why no test ever saw it: the unit suite exercises the routes in-process, and only the
 * artifact we would actually *ship* was broken.
 *
 * Bun embeds the native binding perfectly well — a plain `import('@napi-rs/canvas')` works in a
 * compiled binary (measured). It is pdfjs's *runtime require* that cannot see it. So we import
 * canvas the way that works and install the globals ourselves, **before** pdfjs loads. It only
 * assigns them `if (!globalThis.DOMMatrix)`, so ours win and its own failed require becomes a
 * harmless warning.
 */
async function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsPromise ??= (async () => {
    const canvas = await import('@napi-rs/canvas');
    const globals = globalThis as Record<string, unknown>;
    globals.DOMMatrix ??= canvas.DOMMatrix;
    globals.Path2D ??= canvas.Path2D;
    globals.ImageData ??= canvas.ImageData;

    // **The worker is the same bug one layer down.** pdfjs runs its parser in a worker, and with
    // no `workerSrc` it falls back to a "fake worker" that it loads with `await
    // import('./pdf.worker.mjs')` — a path relative to the module, which in a compiled binary is
    // `/$bunfs/root/...` and does not exist. But it checks `globalThis.pdfjsWorker` *first*
    // (`PDFWorker.#mainThreadWorkerMessageHandler`), so handing it the module we imported with a
    // real specifier — which Bun bundles — means it never looks at the filesystem at all.
    globals.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');

    return import('pdfjs-dist/legacy/build/pdf.mjs');
  })();
  return pdfJsPromise;
}

/** pdfjs takes ownership of the buffer it is given, so hand it a copy. */
function toUint8Array(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function formatMebibytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
