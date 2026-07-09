import {z} from 'zod';

export const nelleErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
  retryable: z.boolean().optional(),
  logRef: z.string().optional(),
});

export type NelleError = z.infer<typeof nelleErrorSchema>;

/**
 * A `run.warning` carries a code for the same reason an `error` does: a browser
 * can render prose, but no other client can branch on it, localize it, or
 * suppress one it already knows about.
 */
export const nelleWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
});

export type NelleWarning = z.infer<typeof nelleWarningSchema>;

export const NELLE_WARNING_CODES = {
  /** Pi failed; Nelle fell back to direct llama.cpp chat completions. */
  piHarnessFallback: 'pi_harness_fallback',
  /** The prompt leaves no room for a reply inside the context window. */
  replyBudgetExhausted: 'reply_budget_exhausted',
  /** The model spent its whole reasoning budget without answering. */
  reasoningBudgetExhausted: 'reasoning_budget_exhausted',
  /** The model produced reasoning but no final text; it is shown instead. */
  reasoningWithoutAnswer: 'reasoning_without_answer',
  /** llama.cpp's slot was still generating after the post-abort grace window. */
  llamaSlotStillProcessing: 'llama_slot_still_processing',
} as const;

export const chatAttachmentKindSchema = z.enum(['text', 'pdf', 'image']);

export const chatAttachmentInputSchema = z.object({
  id: z.string().min(1).max(120),
  kind: chatAttachmentKindSchema,
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(120).optional(),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(25 * 1024 * 1024)
    .optional(),
  text: z.string().max(200_000).optional(),
  data: z.string().max(40_000_000).optional(),
});

export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentInput = z.infer<typeof chatAttachmentInputSchema>;

export const chatRequestSchema = z
  .object({
    message: z.string().min(1),
    attachments: z.array(chatAttachmentInputSchema).max(10).optional(),
  })
  .superRefine((value, context) => {
    const totalSize = (value.attachments ?? []).reduce(
      (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
      0,
    );
    if (totalSize > 100 * 1024 * 1024) {
      context.addIssue({
        code: 'custom',
        message: 'Attachments are limited to 100 MiB per message.',
        path: ['attachments'],
      });
    }

    for (const [index, attachment] of (value.attachments ?? []).entries()) {
      if (attachment.kind === 'image') {
        if (!attachment.mimeType?.startsWith('image/')) {
          context.addIssue({
            code: 'custom',
            message: 'Image attachments require an image MIME type.',
            path: ['attachments', index, 'mimeType'],
          });
        }
        if (!attachment.data) {
          context.addIssue({
            code: 'custom',
            message: 'Image attachments require base64 image data.',
            path: ['attachments', index, 'data'],
          });
        }
        continue;
      }

      if (!attachment.text) {
        context.addIssue({
          code: 'custom',
          message: 'Text and PDF attachments require extracted text.',
          path: ['attachments', index, 'text'],
        });
      }
    }
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const eventEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  conversationId: z.string().optional(),
  runId: z.string().optional(),
  createdAt: z.string().datetime(),
  data: z.unknown(),
});

export type NelleEventEnvelope<TType extends string = string, TData = unknown> = Omit<
  z.infer<typeof eventEnvelopeSchema>,
  'type' | 'data'
> & {
  type: TType;
  data: TData;
};

export function createEventEnvelope<TType extends string, TData>(
  input: Omit<NelleEventEnvelope<TType, TData>, 'id' | 'createdAt'> & {
    id?: string;
    createdAt?: string;
  },
): NelleEventEnvelope<TType, TData> {
  return {
    id: input.id ?? createMonotonicEventId(),
    type: input.type,
    conversationId: input.conversationId,
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    data: input.data,
  };
}

export function serializeSseEnvelope(envelope: NelleEventEnvelope): string {
  const event = sanitizeSseField(envelope.type);
  const id = sanitizeSseField(envelope.id);
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

let lastEventMilliseconds = 0;
let lastEventSequence = 0;

function createMonotonicEventId(): string {
  const now = Date.now();
  if (now === lastEventMilliseconds) {
    lastEventSequence += 1;
  } else {
    lastEventMilliseconds = now;
    lastEventSequence = 0;
  }
  return `${now.toString(36)}-${lastEventSequence.toString(36).padStart(4, '0')}`;
}

function sanitizeSseField(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}
