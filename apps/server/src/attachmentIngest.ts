import {ATTACHMENT_LIMITS} from '../../../packages/shared/src/attachments.ts';
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

/**
 * Turning uploaded bytes into what a model can read: text extraction, PDF page
 * rendering, and image normalization.
 *
 * This ran in the browser, against `pdfjs-dist`, a DOM `canvas`, and a
 * `FileReader`. React Native has none of those, so the work moves here and the
 * client posts bytes.
 */

/** Rendered pages are capped on the long edge, as the browser capped them. */
const MAX_RENDERED_EDGE_PX = 1600;
const MAX_RENDER_SCALE = 2;

export type IngestedUpload = {
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  bytes: Buffer;
  /** Extracted text for `text` and `pdf`. Images carry only bytes. */
  textContent?: string;
  /** Pages a `pdf` holds, so a client can say how many images it would become. */
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
    if (!extracted.text.trim()) {
      throw new UnsupportedAttachmentError(ATTACHMENT_MESSAGES.noExtractableText(name));
    }
    return {
      kind,
      name,
      mimeType: mimeType || 'application/pdf',
      bytes,
      textContent: extracted.text,
      pageCount: extracted.pageCount,
      warnings: extracted.truncated ? [ATTACHMENT_MESSAGES.truncated(name)] : [],
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

export class UnsupportedAttachmentError extends Error {}

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
