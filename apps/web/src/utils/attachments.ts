import type {AttachmentMetadata, LlamaModelProps} from '../api';
import type {DraftAttachment} from '../types';
import {formatBytes} from './format';

export const ATTACHMENT_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 25 * 1024 * 1024,
  maxDraftBytes: 100 * 1024 * 1024,
  maxTextCharacters: 200_000,
  maxRenderedPdfPages: 20,
};

export async function prepareDraftAttachments(
  files: File[],
  input: {existing: DraftAttachment[]; canAttachImages: boolean; renderPdfImages: boolean},
): Promise<{attachments: DraftAttachment[]; warning?: string}> {
  const existingBytes = input.existing.reduce(
    (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
    0,
  );
  let nextBytes = existingBytes;
  const attachments: DraftAttachment[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    const remainingSlots = ATTACHMENT_LIMITS.maxFiles - input.existing.length - attachments.length;
    if (remainingSlots <= 0) {
      throw new Error(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
    }
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(
        `${file.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}.`,
      );
    }
    const result = await prepareDraftAttachment(file, {
      canAttachImages: input.canAttachImages,
      renderPdfImages: input.renderPdfImages,
      remainingSlots,
    });
    const oversizedAttachment = result.attachments.find(
      attachment => (attachment.sizeBytes ?? 0) > ATTACHMENT_LIMITS.maxFileBytes,
    );
    if (oversizedAttachment) {
      throw new Error(
        `${oversizedAttachment.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}.`,
      );
    }
    nextBytes += result.attachments.reduce(
      (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
      0,
    );
    if (nextBytes > ATTACHMENT_LIMITS.maxDraftBytes) {
      throw new Error(
        `Attachments are limited to ${formatBytes(ATTACHMENT_LIMITS.maxDraftBytes)} per message.`,
      );
    }
    if (result.warning) {
      warnings.push(result.warning);
    }
    attachments.push(...result.attachments);
  }
  return {attachments, warning: warnings.join(' ') || undefined};
}

async function prepareDraftAttachment(
  file: File,
  input: {canAttachImages: boolean; renderPdfImages: boolean; remainingSlots: number},
): Promise<{attachments: DraftAttachment[]; warning?: string}> {
  if (isImageFile(file)) {
    if (!input.canAttachImages) {
      throw new Error('Image attachments require a selected model with vision support.');
    }
    return {
      attachments: [
        {
          id: crypto.randomUUID(),
          kind: 'image',
          name: file.name,
          mimeType: file.type || mimeTypeFromName(file.name) || 'image/jpeg',
          sizeBytes: file.size,
          data: await readFileAsBase64(file),
        },
      ],
    };
  }

  if (isPdfFile(file)) {
    if (input.renderPdfImages) {
      if (!input.canAttachImages) {
        throw new Error('PDF image attachments require a selected model with vision support.');
      }
      return renderPdfPageAttachments(file, input.remainingSlots);
    }
    const extracted = await extractPdfText(file);
    if (!extracted.text.trim()) {
      throw new Error(`${file.name} did not contain extractable text.`);
    }
    return {
      attachments: [
        {
          id: crypto.randomUUID(),
          kind: 'pdf',
          name: file.name,
          mimeType: file.type || 'application/pdf',
          sizeBytes: file.size,
          text: extracted.text,
        },
      ],
      warning: extracted.truncated
        ? `${file.name} was truncated to ${ATTACHMENT_LIMITS.maxTextCharacters.toLocaleString()} characters.`
        : undefined,
    };
  }

  if (!isTextFile(file)) {
    throw new Error(`${file.name} is not a supported text, PDF, or image attachment.`);
  }

  const rawText = await file.text();
  if (isBinaryText(rawText)) {
    throw new Error(
      `${file.name} looks like a binary file. Attach text, PDF, or image files only.`,
    );
  }
  const text = rawText.slice(0, ATTACHMENT_LIMITS.maxTextCharacters);
  if (!text.trim()) {
    throw new Error(`${file.name} is empty.`);
  }
  return {
    attachments: [
      {
        id: crypto.randomUUID(),
        kind: 'text',
        name: file.name,
        mimeType: file.type || mimeTypeFromName(file.name) || 'text/plain',
        sizeBytes: file.size,
        text,
      },
    ],
    warning:
      rawText.length > text.length
        ? `${file.name} was truncated to ${ATTACHMENT_LIMITS.maxTextCharacters.toLocaleString()} characters.`
        : undefined,
  };
}

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function renderPdfPageAttachments(
  file: File,
  remainingSlots: number,
): Promise<{attachments: DraftAttachment[]; warning?: string}> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())});
  const pdfDocument = await task.promise;
  const attachments: DraftAttachment[] = [];
  try {
    const pageLimit = Math.min(
      pdfDocument.numPages,
      remainingSlots,
      ATTACHMENT_LIMITS.maxRenderedPdfPages,
    );
    if (pageLimit <= 0) {
      throw new Error(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
    }
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const baseViewport = page.getViewport({scale: 1});
      const scale = Math.min(2, 1600 / Math.max(baseViewport.width, baseViewport.height));
      const viewport = page.getViewport({scale});
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const canvasContext = canvas.getContext('2d');
      if (!canvasContext) {
        throw new Error('Could not create a canvas for PDF rendering.');
      }
      await page.render({canvasContext, canvas, viewport}).promise;
      const dataUrl = canvas.toDataURL('image/png');
      attachments.push({
        id: crypto.randomUUID(),
        kind: 'image',
        name: renderedPdfPageName(file.name, pageNumber),
        mimeType: 'image/png',
        sizeBytes: dataUrlByteLength(dataUrl),
        data: dataUrl,
      });
      page.cleanup();
    }
    const skippedPages = pdfDocument.numPages - pageLimit;
    return {
      attachments,
      warning:
        skippedPages > 0
          ? `${file.name} was rendered as ${pageLimit.toLocaleString()} page image${pageLimit === 1 ? '' : 's'}; ${skippedPages.toLocaleString()} remaining page${skippedPages === 1 ? '' : 's'} skipped by attachment limits.`
          : undefined,
    };
  } finally {
    await pdfDocument.cleanup();
    await task.destroy();
  }
}

async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= import('pdfjs-dist').then(module => {
    return import('pdfjs-dist/build/pdf.worker.mjs?url').then(workerModule => {
      module.GlobalWorkerOptions.workerSrc = pdfWorkerUrlFromModule(workerModule);
      return module;
    });
  });
  return pdfJsPromise;
}

function pdfWorkerUrlFromModule(workerModule: unknown): string {
  if (typeof workerModule === 'string') {
    return workerModule;
  }
  const value = (workerModule as {default?: unknown}).default;
  if (typeof value !== 'string') {
    throw new Error('Could not resolve the PDF worker URL.');
  }
  return value;
}

async function extractPdfText(file: File): Promise<{text: string; truncated: boolean}> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())});
  const document = await task.promise;
  const pages: string[] = [];
  let truncated = false;
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
        truncated = true;
        return {
          text: currentText.slice(0, ATTACHMENT_LIMITS.maxTextCharacters),
          truncated,
        };
      }
    }
    return {text: pages.join('\n\n'), truncated};
  } finally {
    await document.cleanup();
    await task.destroy();
  }
}

async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('File read failed.')));
    reader.readAsDataURL(file);
  });
  return dataUrl.split(',')[1] ?? '';
}

function renderedPdfPageName(fileName: string, pageNumber: number): string {
  const baseName = fileName.replace(/\.pdf$/i, '') || 'PDF';
  return `${baseName} page ${pageNumber}.png`;
}

function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] ?? dataUrl;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export function getDraftAttachmentError(
  attachments: DraftAttachment[],
  activeModelProps: LlamaModelProps | null,
): string | null {
  if (!attachments.some(attachment => attachment.kind === 'image')) {
    return null;
  }
  if (activeModelProps?.modalities.vision === true) {
    return null;
  }
  return 'Image attachments require a selected model with vision support.';
}

export function attachmentTooltip(attachment: DraftAttachment | AttachmentMetadata): string {
  const type =
    attachment.kind === 'pdf' ? 'PDF text' : attachment.kind === 'image' ? 'Image' : 'Text file';
  return `${type} · ${formatBytes(attachment.sizeBytes ?? null)}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith('text/') ||
    /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|toml|ini|sql)$/i.test(file.name)
  );
}

function mimeTypeFromName(name: string): string | undefined {
  if (/\.pdf$/i.test(name)) {
    return 'application/pdf';
  }
  if (/\.png$/i.test(name)) {
    return 'image/png';
  }
  if (/\.webp$/i.test(name)) {
    return 'image/webp';
  }
  if (/\.gif$/i.test(name)) {
    return 'image/gif';
  }
  if (/\.jpe?g$/i.test(name)) {
    return 'image/jpeg';
  }
  return undefined;
}

function isBinaryText(value: string): boolean {
  return value.includes('\u0000');
}
