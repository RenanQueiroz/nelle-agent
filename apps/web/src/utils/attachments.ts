import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_LIMIT_MESSAGES,
} from '../../../../packages/shared/src/attachments.ts';
import {ATTACHMENT_MESSAGES} from '../../../../packages/shared/src/attachmentRules.ts';
import {deleteUpload, uploadAttachment} from '../api';
import type {AttachmentMetadata} from '../api';
import type {DraftAttachment} from '../types';
import {formatBytes} from './format';

// The limits are shared with `chatRequestSchema`, which enforces them again on
// the server. Two copies of a number is how the composer came to allow eleven
// files that the server answered with an HTTP 500.
export {ATTACHMENT_LIMITS};

/**
 * Posts each file to the server and keeps the reference it hands back.
 *
 * Classification, PDF text extraction, page rendering, truncation, and the
 * binary check all run on the server now: React Native has no canvas and no
 * `FileReader`, and a rule enforced in the browser is a rule the next client has
 * to reimplement. The browser sends bytes and shows what came back.
 */
export async function prepareDraftAttachments(
  files: File[],
  input: {existing: DraftAttachment[]; canAttachImages: boolean; conversationId?: string},
): Promise<{attachments: DraftAttachment[]; warning?: string}> {
  let totalBytes = input.existing.reduce((sum, attachment) => sum + (attachment.sizeBytes ?? 0), 0);
  const attachments: DraftAttachment[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    if (input.existing.length + attachments.length >= ATTACHMENT_LIMITS.maxFiles) {
      throw new Error(ATTACHMENT_LIMIT_MESSAGES.tooManyFiles);
    }
    // Refuse an oversized file before spending a round trip on it. The server
    // refuses it again, because a client is never the gate.
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(
        `${file.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}.`,
      );
    }
    if (!input.canAttachImages && looksLikeImage(file)) {
      throw new Error(ATTACHMENT_MESSAGES.visionRequired);
    }

    const uploaded = await uploadAttachment(file, input.conversationId);
    totalBytes += uploaded.sizeBytes;
    if (totalBytes > ATTACHMENT_LIMITS.maxDraftBytes) {
      // The bytes reached the server. Drop them rather than leave an upload the
      // user cannot see and will never send.
      await deleteUpload(uploaded.uploadId).catch(() => undefined);
      throw new Error(ATTACHMENT_LIMIT_MESSAGES.draftTooLarge);
    }
    attachments.push({
      uploadId: uploaded.uploadId,
      kind: uploaded.kind,
      name: uploaded.name,
      mimeType: uploaded.mimeType,
      sizeBytes: uploaded.sizeBytes,
      pageCount: uploaded.pageCount,
      hasTextLayer: uploaded.hasTextLayer,
    });
    warnings.push(...uploaded.warnings);
  }

  return {attachments, warning: warnings.join(' ') || undefined};
}

/**
 * A conservative UI gate: it blocks an image while the model's vision support is
 * unknown, because the user can simply load the model. The server only refuses
 * what llama.cpp has proven cannot be read.
 */
function looksLikeImage(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

export function getDraftAttachmentError(
  attachments: DraftAttachment[],
  canAttachImages: boolean,
): string | null {
  if (!attachments.some(attachment => attachment.kind === 'image')) {
    return null;
  }
  return canAttachImages ? null : ATTACHMENT_MESSAGES.visionRequired;
}

export function attachmentTooltip(attachment: DraftAttachment | AttachmentMetadata): string {
  const type = attachmentTypeLabel(attachment);
  const pages =
    'pageCount' in attachment && attachment.pageCount
      ? ` · ${attachment.pageCount} page${attachment.pageCount === 1 ? '' : 's'}`
      : '';
  return `${type} · ${formatBytes(attachment.sizeBytes ?? null)}${pages}`;
}

/**
 * A PDF says how it will reach the model. The server decides that from the
 * document, so a scan announces itself as pages rather than as text it has not
 * got.
 */
function attachmentTypeLabel(attachment: DraftAttachment | AttachmentMetadata): string {
  if (attachment.kind === 'image') {
    return 'Image';
  }
  if (attachment.kind !== 'pdf') {
    return 'Text file';
  }
  return 'hasTextLayer' in attachment && attachment.hasTextLayer === false
    ? 'PDF pages'
    : 'PDF text';
}
