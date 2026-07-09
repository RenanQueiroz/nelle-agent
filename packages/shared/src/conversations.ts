import {z} from 'zod';

import {chatAttachmentKindSchema, nelleErrorSchema} from './contracts.ts';
import {reasoningLevelSchema} from './reasoning.ts';

export const conversationStatusSchema = z.enum([
  'ready',
  'running',
  'compacting',
  'aborting',
  'unavailable',
]);

export const activeRunStatusSchema = z.enum(['pending', 'running', 'aborting']);

export const terminalRunStatusSchema = z.enum(['completed', 'aborted', 'failed']);

export const runKindSchema = z.enum(['chat', 'regenerate', 'compact', 'title']);

export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type ActiveRunStatus = z.infer<typeof activeRunStatusSchema>;
export type TerminalRunStatus = z.infer<typeof terminalRunStatusSchema>;
export type RunKind = z.infer<typeof runKindSchema>;

export const conversationEntryProjectionSchema = z.object({
  conversationId: z.string(),
  piEntryId: z.string(),
  parentPiEntryId: z.string().optional(),
  entryType: z.string(),
  role: z.enum(['user', 'assistant', 'system']).optional(),
  textPreview: z.string().optional(),
  createdAt: z.string(),
  modelId: z.string().optional(),
  modelRuntimeId: z.string().optional(),
  modelAliasSnapshot: z.string().optional(),
  performance: z.unknown().optional(),
  toolCalls: z.unknown().optional(),
  attachmentSummary: z.unknown().optional(),
  regeneratesPiEntryId: z.string().optional(),
  displayGroupId: z.string().optional(),
  /** Thinking text llama.cpp streamed as `reasoning_content`. */
  reasoning: z.string().optional(),
});

export type ConversationEntryProjection = z.infer<typeof conversationEntryProjectionSchema>;

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

export const conversationContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().positive().optional(),
  source: z.enum(['estimate', 'prompt_progress', 'timings', 'pi']).optional(),
  updatedAt: z.string().optional(),
});

export type ConversationContextUsage = z.infer<typeof conversationContextUsageSchema>;

export const modelListItemSchema = z.object({
  id: z.string(),
  alias: z.string(),
  status: z.string().optional(),
});

export type ModelListItem = z.infer<typeof modelListItemSchema>;

export const conversationSnapshotSchema = z.object({
  conversation: z.object({
    id: z.string(),
    title: z.string(),
    titleSource: z.enum(['generated', 'user', 'imported', 'fallback']),
    pinned: z.boolean(),
    status: conversationStatusSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    piSessionId: z.string().optional(),
    activeLeafPiEntryId: z.string().optional(),
    defaultModelId: z.string().optional(),
    parentConversationId: z.string().optional(),
    forkedFromPiEntryId: z.string().optional(),
    forkKind: z.enum(['fork', 'clone']).optional(),
    reasoningLevel: reasoningLevelSchema,
    currentRun: z
      .object({
        runId: z.string(),
        kind: runKindSchema,
        modelId: z.string().optional(),
        startedAt: z.string(),
        status: activeRunStatusSchema,
      })
      .optional(),
  }),
  entries: z.array(conversationEntryProjectionSchema),
  activePathEntryIds: z.array(z.string()),
  attachments: z.array(attachmentMetadataSchema),
  context: conversationContextUsageSchema,
  models: z.object({
    selectedModelId: z.string().optional(),
    defaultModelId: z.string().optional(),
    available: z.array(modelListItemSchema),
  }),
  /**
   * What the *conversation* permits, as of this snapshot.
   *
   * Runtime state is deliberately absent: whether llama.cpp is up, or a model is
   * selected, belongs to the client, which ANDs it in. A client that tracks live
   * run state (the browser does) should prefer its own `canAbort`/`canCompact`,
   * because a run started after this snapshot was taken. Clients without one
   * read these fields directly.
   */
  capabilities: z.object({
    canSend: z.boolean(),
    canAbort: z.boolean(),
    canCompact: z.boolean(),
    canFork: z.boolean(),
    /** The Pi session file is unreadable; offer repair and rebuild. */
    canRepair: z.boolean(),
    /**
     * Last-known vision support for the conversation's model, from `model_cache`.
     * `null` means llama.cpp has never reported props for it, so image support is
     * unknown rather than absent. Best effort: a client that can reach the router
     * should prefer live `/props`.
     */
    canAttachImages: z.boolean().nullable(),
  }),
  errors: z.array(nelleErrorSchema),
});

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

const allowedConversationTransitions: Record<ConversationStatus, Set<ConversationStatus>> = {
  ready: new Set(['running', 'compacting', 'unavailable']),
  running: new Set(['ready', 'aborting', 'unavailable']),
  compacting: new Set(['ready', 'aborting', 'unavailable']),
  aborting: new Set(['ready', 'unavailable']),
  unavailable: new Set(['ready']),
};

export function canTransitionConversation(
  from: ConversationStatus,
  to: ConversationStatus,
): boolean {
  return from === to || (allowedConversationTransitions[from]?.has(to) ?? false);
}

export function assertConversationTransition(
  from: ConversationStatus,
  to: ConversationStatus,
): void {
  if (!canTransitionConversation(from, to)) {
    const error = new Error(`Invalid conversation status transition: ${from} -> ${to}`);
    Object.assign(error, {
      code: 'invalid_conversation_transition',
      retryable: false,
    });
    throw error;
  }
}
