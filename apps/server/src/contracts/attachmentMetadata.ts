import {z} from 'zod';

import {chatAttachmentKindSchema} from './contracts.ts';

/**
 * Persisted metadata for one attachment.
 *
 * It lives in its own module because both `conversations.ts` and `messages.ts`
 * need it at runtime, and importing it from either would make them circular.
 * It cannot live in `attachments.ts`, which holds the limits: that module is
 * imported by the web app and must stay zod-free.
 */
export const attachmentMetadataSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  piEntryId: z.string().optional(),
  uploadId: z.string().optional(),
  kind: chatAttachmentKindSchema,
  name: z.string(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  storagePath: z.string().optional(),
  textPreview: z.string().optional(),
  processing: z.unknown().optional(),
  createdAt: z.string(),
});

export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;
