import {z} from 'zod';

import {ATTACHMENT_LIMITS, ATTACHMENT_LIMIT_MESSAGES} from './attachments.ts';

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

/**
 * Every stable `NelleError.code` Nelle emits.
 *
 * User-facing text comes from `message`; clients branch on `code`. Keeping the
 * set in one place is the only way a second client can know what it may see.
 */
/** `PATCH /api/settings/preferences`. Preferences that follow the user. */
export const preferencesSchema = z.object({
  favoriteModelIds: z.array(z.string().min(1)).max(200).optional(),
  showGenerationStats: z.boolean().optional(),
  showThinkingInProgress: z.boolean().optional(),
  showToolCallsInProgress: z.boolean().optional(),
  renderUserContentAsMarkdown: z.boolean().optional(),
  renderThinkingAsMarkdown: z.boolean().optional(),
  disableAutoScroll: z.boolean().optional(),
});

export type PreferencesInput = z.infer<typeof preferencesSchema>;

export const NELLE_ERROR_CODES = {
  // Conversation and session lifecycle.
  conversationBusy: 'conversation_busy',
  conversationNotFound: 'conversation_not_found',
  invalidConversationTransition: 'invalid_conversation_transition',
  sessionUnavailable: 'session_unavailable',

  // Runtime and model.
  llamaServerStopped: 'llama_server_stopped',
  modelNotFound: 'model_not_found',
  modelLoadFailed: 'model_load_failed',
  contextOverflow: 'context_overflow',

  // Request validation.
  invalidRequest: 'invalid_request',
  notFound: 'not_found',

  // Device authentication (LAN clients).
  unauthorized: 'unauthorized',
  pairingCodeInvalid: 'pairing_code_invalid',
  refreshTokenInvalid: 'refresh_token_invalid',

  // `models.ini` parameter editing. The response also carries `invalidParams`,
  // so a client can mark the rows rather than parse one sentence.
  invalidModelParam: 'invalid_model_param',
  reservedModelParam: 'reserved_model_param',
  duplicateModelParam: 'duplicate_model_param',

  // Chat input.
  unsupportedAttachment: 'unsupported_attachment',
  unsupportedSlashCommand: 'unsupported_slash_command',

  // Host tools.
  hostToolsAcknowledgementRequired: 'host_tools_acknowledgement_required',
  toolsDisabled: 'tools_disabled',

  // Run failures.
  piRunFailed: 'pi_run_failed',
  /** Pi asked llama.cpp for a reply too short to be an answer. */
  replyBudgetExhausted: 'reply_budget_exhausted',
  llamaDirectFailed: 'llama_direct_failed',
  compactFailed: 'compact_failed',
  titleGenerationFailed: 'title_generation_failed',
  streamFailed: 'stream_failed',

  // Archives.
  invalidArchive: 'invalid_archive',
  invalidArchiveUpload: 'invalid_archive_upload',
  archiveSessionMissing: 'archive_session_missing',

  internalError: 'internal_error',
} as const;

export type NelleErrorCode = (typeof NELLE_ERROR_CODES)[keyof typeof NELLE_ERROR_CODES];

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
  sizeBytes: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.maxFileBytes).optional(),
  text: z.string().max(ATTACHMENT_LIMITS.maxTextCharacters).optional(),
  data: z.string().max(ATTACHMENT_LIMITS.maxImageDataCharacters).optional(),
});

export type ChatAttachmentKind = z.infer<typeof chatAttachmentKindSchema>;
export type ChatAttachmentInput = z.infer<typeof chatAttachmentInputSchema>;

/**
 * What a chat request carries. The bytes went to `POST /api/uploads` first, so a
 * client references them rather than embedding them.
 *
 * There is no `renderPdfAsImages`: the server reads a PDF's text when it has a
 * text layer and renders its pages when it has not, because only the server
 * knows both the document and the model.
 */
export const chatAttachmentReferenceSchema = z
  .object({
    uploadId: z.string().min(1).max(120),
  })
  // A client still embedding `text` or `data`, or still asking for a rendering
  // mode, is talking to an older server and must be told so rather than having
  // its request silently reinterpreted.
  .strict();

export type ChatAttachmentReference = z.infer<typeof chatAttachmentReferenceSchema>;

export const chatRequestSchema = z
  .object({
    message: z.string().min(1),
    attachments: z
      .array(chatAttachmentReferenceSchema)
      .max(ATTACHMENT_LIMITS.maxFiles, {message: ATTACHMENT_LIMIT_MESSAGES.tooManyFiles})
      .optional(),
  })
  // The old shape carried `text` and `data`, and this is where their invariants
  // were enforced. A reference has none: the bytes were validated at upload, and
  // the per-message limits are enforced in `resolveChatAttachments`, after a PDF
  // asked to render has become N page images.
  .strict();

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
