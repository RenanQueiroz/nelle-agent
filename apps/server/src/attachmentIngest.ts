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
    return {kind, name, mimeType: mimeType || 'image/jpeg', bytes, warnings: []};
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
  input: {name: string; maxPages: number},
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
      const scale = Math.min(
        MAX_RENDER_SCALE,
        MAX_RENDERED_EDGE_PX / Math.max(baseViewport.width, baseViewport.height),
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
  model: {contextSize: number; visionSupport: boolean | null},
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

  const imageBudget = maxAffordableImages(model.contextSize);
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
  contextSize: number;
  imageCount: number;
  imageBudget: number;
  scanName?: string;
}): UnsupportedAttachmentError {
  const tokens = (input.imageCount * PI_ESTIMATED_IMAGE_TOKENS).toLocaleString();
  const needed = minimumContextSizeForImages(input.imageCount, PI_AGENT_PROMPT_TOKENS);
  const subject = input.scanName
    ? `${input.scanName} has no text layer, so its ${plural(input.imageCount, 'page')} must be ` +
      `read as images (${tokens} tokens)`
    : `${plural(input.imageCount, 'image')} need ${tokens} tokens`;
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
 */
async function loadPdfJs(): Promise<PdfJsModule> {
  pdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfJsPromise;
}

/** pdfjs takes ownership of the buffer it is given, so hand it a copy. */
function toUint8Array(bytes: Buffer): Uint8Array {
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function formatMebibytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}
