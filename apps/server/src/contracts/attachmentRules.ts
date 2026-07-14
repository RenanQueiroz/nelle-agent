import {ATTACHMENT_LIMITS} from './attachments.ts';

/**
 * How an attachment is classified, truncated, and named.
 *
 * These rules used to live in the browser, next to `FileReader` and `canvas`,
 * where a second client could not reach them. They take a descriptor rather than
 * a `File`, so the server can apply the same rules to an uploaded byte stream.
 * Zod-free: the web bundle imports this module directly.
 */

export type AttachmentKind = 'text' | 'pdf' | 'image';

export type AttachmentDescriptor = {
  name: string;
  /** The browser's `File.type` or the upload's `Content-Type`. Often empty. */
  mimeType?: string;
};

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif)$/i;
const PDF_EXTENSION = /\.pdf$/i;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|toml|ini|sql)$/i;

export function isImageAttachment({name, mimeType}: AttachmentDescriptor): boolean {
  return Boolean(mimeType?.startsWith('image/')) || IMAGE_EXTENSIONS.test(name);
}

export function isPdfAttachment({name, mimeType}: AttachmentDescriptor): boolean {
  return mimeType === 'application/pdf' || PDF_EXTENSION.test(name);
}

export function isTextAttachment({name, mimeType}: AttachmentDescriptor): boolean {
  return Boolean(mimeType?.startsWith('text/')) || TEXT_EXTENSIONS.test(name);
}

/**
 * The kind Nelle will treat the file as, or `null` for one it will not accept.
 * Image beats PDF beats text, matching the order the composer checked them in.
 */
export function classifyAttachment(descriptor: AttachmentDescriptor): AttachmentKind | null {
  if (isImageAttachment(descriptor)) {
    return 'image';
  }
  if (isPdfAttachment(descriptor)) {
    return 'pdf';
  }
  return isTextAttachment(descriptor) ? 'text' : null;
}

/** A browser often reports an empty `File.type`; the extension is the fallback. */
export function mimeTypeFromName(name: string): string | undefined {
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

/** A NUL byte is the cheap, reliable tell that a "text" file is not text. */
export function isBinaryText(value: string): boolean {
  return value.includes('\u0000');
}

export function truncateAttachmentText(value: string): {text: string; truncated: boolean} {
  if (value.length <= ATTACHMENT_LIMITS.maxTextCharacters) {
    return {text: value, truncated: false};
  }
  return {text: value.slice(0, ATTACHMENT_LIMITS.maxTextCharacters), truncated: true};
}

export function renderedPdfPageName(fileName: string, pageNumber: number): string {
  const baseName = fileName.replace(PDF_EXTENSION, '') || 'PDF';
  return `${baseName} page ${pageNumber}.png`;
}

/** Byte length of the payload a `data:` URL or bare base64 string encodes. */
export function dataUrlByteLength(dataUrl: string): number {
  const base64 = dataUrl.split(',')[1] ?? dataUrl;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

export const ATTACHMENT_MESSAGES = {
  /** Says what changed, because the user's file is not what reaches the model. */
  downscaled: (name: string, megapixels: number) =>
    `${name} was downscaled to ${megapixels.toFixed(1)} megapixels.`,
  unsupportedKind: (name: string) =>
    `${name} is not a supported text, PDF, or image attachment.` as const,
  binaryFile: (name: string) =>
    `${name} looks like a binary file. Attach text, PDF, or image files only.` as const,
  emptyFile: (name: string) => `${name} is empty.` as const,
  noExtractableText: (name: string) => `${name} did not contain extractable text.` as const,
  truncated: (name: string) =>
    `${name} was truncated to ${ATTACHMENT_LIMITS.maxTextCharacters.toLocaleString()} characters.` as const,
  visionRequired: 'Image attachments require a selected model with vision support.',
  pdfVisionRequired: 'PDF image attachments require a selected model with vision support.',
} as const;
