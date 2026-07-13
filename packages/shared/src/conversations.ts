import {z} from 'zod';

import {conversationMessageSchema} from './messages.ts';

import {attachmentMetadataSchema} from './attachmentMetadata.ts';
import {nelleErrorSchema} from './contracts.ts';

export {attachmentMetadataSchema};
export type {AttachmentMetadata} from './attachmentMetadata.ts';
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

export const conversationContextUsageSchema = z.object({
  usedTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().positive().optional(),
  source: z.enum(['estimate', 'prompt_progress', 'timings', 'pi']).optional(),
  /**
   * Derived server-side from the shared thresholds so clients pick a colour
   * rather than re-deriving the rule. Optional: rows written before this field
   * existed parse, and the server restamps them on read.
   */
  status: z.enum(['ok', 'warning', 'overflow']).optional(),
  updatedAt: z.string().optional(),
});

export type ConversationContextUsage = z.infer<typeof conversationContextUsageSchema>;

export const modelListItemSchema = z.object({
  id: z.string(),
  alias: z.string(),
  status: z.string().optional(),
});

export type ModelListItem = z.infer<typeof modelListItemSchema>;

export const conversationTitleSourceSchema = z.enum(['generated', 'user', 'imported', 'fallback']);

export type ConversationTitleSource = z.infer<typeof conversationTitleSourceSchema>;

export const conversationSnapshotSchema = z.object({
  conversation: z.object({
    id: z.string(),
    title: z.string(),
    titleSource: conversationTitleSourceSchema,
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
  /**
   * What a client renders. Derived from `entries` by `buildConversationMessages`,
   * which hides replayed user turns, drops ghost assistant entries, and labels
   * regenerate variants. `entries` stays for a future branch explorer; nothing in
   * a normal client should read it.
   */
  messages: z.array(conversationMessageSchema),
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
    /**
     * Whether the conversation's model declares a thinking mode, from
     * `model_cache`. `null` means llama.cpp has never reported its chat template,
     * so the reasoning control stays editable rather than locking to `off`.
     */
    canReason: z.boolean().nullable(),
  }),
  errors: z.array(nelleErrorSchema),
});

export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;

/** One row of the keyset-paginated conversation sidebar list. */
export const conversationListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleSource: conversationTitleSourceSchema,
  pinned: z.boolean(),
  status: conversationStatusSchema,
  updatedAt: z.string(),
  defaultModelId: z.string().optional(),
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * `GET /api/conversations`: a page of {@link conversationListItemSchema} rows, an
 * opaque keyset `nextCursor`, and `total` (every conversation matching the search,
 * not only the ones on this page).
 */
export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  nextCursor: z.string().optional(),
  total: z.number().int().nonnegative(),
});

export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

/**
 * `POST /api/conversations/:id/fork` — branch the conversation **at a message**.
 *
 * `entryId` is required, and that is the whole difference from a clone: a fork starts a new
 * conversation from a point *inside* this one, so it must be told which point. It is a
 * transcript action (a footer on a user message), never a sidebar one.
 */
export const forkConversationRequestSchema = z.object({
  entryId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
});

export type ForkConversationRequest = z.infer<typeof forkConversationRequestSchema>;

/**
 * `POST /api/conversations/:id/clone` — duplicate the conversation.
 *
 * `entryId` is **optional**: absent means the whole conversation, which is what the sidebar's
 * "Duplicate" does. The source conversation is left completely unchanged either way.
 */
export const cloneConversationRequestSchema = z.object({
  entryId: z.string().min(1).optional(),
  title: z.string().min(1).max(200).optional(),
});

export type CloneConversationRequest = z.infer<typeof cloneConversationRequestSchema>;

/**
 * What fork, clone and **import** all answer with: a brand new conversation, and its snapshot.
 *
 * One shape, because they are one act -- a conversation came into existence. Import is not a
 * merge and never has been: it always creates a new conversation, so an archive imported twice
 * gives you two.
 */
export const conversationCreatedResponseSchema = z.object({
  conversation: conversationListItemSchema,
  snapshot: conversationSnapshotSchema,
});

export type ConversationCreatedResponse = z.infer<typeof conversationCreatedResponseSchema>;

/**
 * `GET /api/conversations/:id/diagnostics` — *why* a conversation is `unavailable`.
 *
 * A conversation is bound to one Pi session JSONL file, and that file is the authoritative
 * history. If it goes missing or will not parse, the conversation is `unavailable` and no read
 * path may quietly create a replacement. This says what actually happened, so the user can
 * choose between the three explicit exits (repair, rebuild, delete) with the facts in front of
 * them rather than guessing.
 *
 * `exists: false` with a `reason` is the interesting case. The counts are what a **rebuild**
 * would have to work from: `projectionEntryCount` is how many entries survive in
 * `conversation_entry_projection`, and it is the ceiling on what a rebuild can recover.
 */
export const conversationDiagnosticsSchema = z.object({
  conversationId: z.string(),
  status: conversationStatusSchema,
  /** Where the Pi session file should be. Absent if the conversation was never bound. */
  piSessionPath: z.string().optional(),
  piSessionId: z.string().optional(),
  /** Whether the Pi session file is present **and** readable. */
  exists: z.boolean(),
  /** Why it is not, in the filesystem's own words. Absent when `exists` is true. */
  reason: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  /** What a rebuild would have to work from -- and therefore the most it could recover. */
  projectionEntryCount: z.number().int().nonnegative(),
  attachmentCount: z.number().int().nonnegative(),
  toolAuditCount: z.number().int().nonnegative(),
});

export type ConversationDiagnostics = z.infer<typeof conversationDiagnosticsSchema>;

/**
 * The manifest inside a `.nelle-chat.zip`.
 *
 * Served in the contract even though **the archive itself is not JSON**: the bytes are a zip and
 * always will be, but a client that wants to say what an archive *is* -- before importing it, or
 * when the server refuses it -- needs to be able to read this. `files` maps each entry to its
 * checksum, and the import verifies every one.
 *
 * `piSessionMissing` is the one that matters. Exporting an `unavailable` conversation is
 * **allowed** (you should be able to get your data out of a broken chat), and the archive says
 * so. Importing that archive is then refused with `archive_session_missing` -- because the
 * alternative is silently creating an empty conversation, which looks like success.
 */
export const ARCHIVE_FORMAT = 'nelle-chat';
export const ARCHIVE_VERSION = 1;

/**
 * Named, not inlined. An anonymous nested object codegens into `Conversation2` / `Source` --
 * names nobody can reason about -- which is the same reason `ChatAttachmentReference` is
 * registered by name rather than left inside `ChatRequest`.
 */
export const archiveConversationRefSchema = z.object({
  id: z.string(),
  title: z.string(),
});

export type ArchiveConversationRef = z.infer<typeof archiveConversationRefSchema>;

export const archiveSourceSchema = z.object({
  platform: z.string(),
});

export type ArchiveSource = z.infer<typeof archiveSourceSchema>;

export const conversationArchiveManifestSchema = z.object({
  format: z.literal(ARCHIVE_FORMAT),
  version: z.literal(ARCHIVE_VERSION),
  exportedAt: z.string(),
  appVersion: z.string(),
  conversation: archiveConversationRefSchema.optional(),
  source: archiveSourceSchema.optional(),
  /** Exported from a conversation whose Pi session file was already lost. */
  piSessionMissing: z.boolean().optional(),
  /** Every file in the archive, by checksum. The import verifies all of them. */
  files: z.record(z.string(), z.string()),
});

export type ConversationArchiveManifest = z.infer<typeof conversationArchiveManifestSchema>;

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
