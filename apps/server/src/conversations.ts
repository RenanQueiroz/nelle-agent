import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type {DatabaseSync} from 'node:sqlite';

import type {
  AttachmentMetadata,
  ConversationContextUsage,
  ConversationEntryProjection,
  ConversationSnapshot,
  ConversationStatus,
  ModelListItem,
} from '../../../packages/shared/src/conversations.ts';
import {
  assertConversationTransition,
  conversationContextUsageSchema,
  conversationSnapshotSchema,
} from '../../../packages/shared/src/conversations.ts';
import type {ChatAttachmentKind} from '../../../packages/shared/src/contracts.ts';
import type {ReasoningLevel} from '../../../packages/shared/src/reasoning.ts';
import {
  DEFAULT_NEW_CONVERSATION_REASONING_LEVEL,
  normalizeReasoningLevel,
} from '../../../packages/shared/src/reasoning.ts';
import type {AppDatabase} from './database';
import {sanitizeStoredPerformance} from './llamaThroughput';
import type {AppState, ChatMessage, ConfiguredModel} from './types';

export const LEGACY_DEFAULT_CONVERSATION_ID = 'legacy-default';

type ConversationRow = {
  id: string;
  title: string;
  title_source: ConversationSnapshot['conversation']['titleSource'];
  pinned: number;
  pi_session_path: string | null;
  pi_session_id: string | null;
  active_leaf_pi_entry_id: string | null;
  last_synced_pi_entry_id: string | null;
  default_model_id: string | null;
  parent_conversation_id: string | null;
  forked_from_pi_entry_id: string | null;
  fork_kind: 'fork' | 'clone' | null;
  context_usage_json: string | null;
  reasoning_level: ReasoningLevel;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type EntryRow = {
  conversation_id: string;
  pi_entry_id: string;
  parent_pi_entry_id: string | null;
  entry_type: string;
  role: ChatMessage['role'] | null;
  text_preview: string | null;
  created_at: string;
  model_id: string | null;
  model_runtime_id: string | null;
  model_alias_snapshot: string | null;
  performance_json: string | null;
  tool_calls_json: string | null;
  attachment_summary_json: string | null;
  regenerates_pi_entry_id: string | null;
  display_group_id: string | null;
  reasoning_text: string | null;
};

type AttachmentRow = {
  id: string;
  conversation_id: string;
  pi_entry_id: string | null;
  upload_id: string | null;
  kind: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  text_content: string | null;
  processing_json: string | null;
  created_at: string;
};

export type ConversationListItem = {
  id: string;
  title: string;
  titleSource: ConversationSnapshot['conversation']['titleSource'];
  pinned: boolean;
  status: ConversationStatus;
  updatedAt: string;
  defaultModelId?: string;
};

export type ConversationPage = {
  conversations: ConversationListItem[];
  nextCursor?: string;
  /** Every conversation matching the search, not only the ones on this page. */
  total: number;
};

/**
 * Keyset cursor over `(updated_at, id)`.
 *
 * An offset cursor would skip rows: answering a chat bumps its `updated_at`,
 * which reorders the very list being paged through. The last row of the previous
 * page is a stable place to resume from, and `id` breaks ties between two
 * conversations updated in the same millisecond.
 */
type ConversationCursor = {updatedAt: string; id: string};

/** Pinned rows are few by construction, but refuse to unbound the query. */
const MAX_PINNED_CONVERSATIONS = 200;

function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): ConversationCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ConversationCursor).updatedAt === 'string' &&
      typeof (parsed as ConversationCursor).id === 'string'
    ) {
      return parsed as ConversationCursor;
    }
  } catch {
    // A cursor is opaque to callers, so a malformed one is indistinguishable
    // from a stale one. Start over rather than failing the list request.
  }
  return null;
}

export type PiSessionBinding = {
  piSessionPath: string;
  piSessionId: string;
  activeLeafPiEntryId?: string | null;
};

export type SyncConversationEntry = {
  piEntryId: string;
  parentPiEntryId?: string | null;
  entryType: string;
  role?: ChatMessage['role'] | null;
  text: string;
  createdAt: string;
  modelId?: string | null;
  modelRuntimeId?: string | null;
  modelAliasSnapshot?: string | null;
  performance?: unknown;
  toolCalls?: unknown;
  attachmentSummary?: unknown;
  regeneratesPiEntryId?: string | null;
  displayGroupId?: string | null;
  reasoning?: string | null;
};

export type CreateAttachmentInput = {
  uploadId: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  textContent?: string;
  processing?: unknown;
  createdAt?: string;
};

export type StoredAttachment = AttachmentMetadata & {
  uploadId?: string;
  textContent?: string;
  processing?: unknown;
};

export type ImportedAttachmentInput = {
  piEntryId?: string | null;
  uploadId?: string | null;
  kind: ChatAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  textContent?: string;
  processing?: unknown;
  createdAt?: string;
};

export type RegenerationSource = {
  assistantEntry: ConversationEntryProjection;
  userEntry: ConversationEntryProjection;
  branchFromPiEntryId: string | null;
  regeneratesPiEntryId: string;
  displayGroupId: string;
};

export type ConversationDeleteResources = {
  piSessionPaths: string[];
  attachmentStoragePaths: string[];
};

export type ConversationDiagnostics = {
  conversationId: string;
  status: ConversationStatus;
  piSessionPath?: string;
  piSessionId?: string;
  exists: boolean;
  reason?: string;
  sizeBytes?: number;
  projectionEntryCount: number;
  attachmentCount: number;
  toolAuditCount: number;
};

export class ConversationRepository {
  constructor(private readonly database: AppDatabase) {}

  async init(): Promise<void> {
    await this.database.open();
  }

  createConversation(
    input: {
      id?: string;
      title?: string;
      defaultModelId?: string | null;
      titleSource?: ConversationSnapshot['conversation']['titleSource'];
      parentConversationId?: string | null;
      forkedFromPiEntryId?: string | null;
      forkKind?: 'fork' | 'clone' | null;
      reasoningLevel?: ReasoningLevel;
    } = {},
  ): ConversationListItem {
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const row: ConversationRow = {
      id,
      title: input.title ?? 'New chat',
      title_source: input.titleSource ?? 'fallback',
      pinned: 0,
      pi_session_path: null,
      pi_session_id: null,
      active_leaf_pi_entry_id: null,
      last_synced_pi_entry_id: null,
      default_model_id: input.defaultModelId ?? null,
      parent_conversation_id: input.parentConversationId ?? null,
      forked_from_pi_entry_id: input.forkedFromPiEntryId ?? null,
      fork_kind: input.forkKind ?? null,
      context_usage_json: null,
      reasoning_level: input.reasoningLevel ?? DEFAULT_NEW_CONVERSATION_REASONING_LEVEL,
      status: 'ready',
      created_at: now,
      updated_at: now,
      deleted_at: null,
    };
    this.insertConversation(row);
    this.upsertSearch(row.id, row.title);
    return mapConversationListItem(row);
  }

  ensureConversation(
    id: string,
    input: {
      title?: string;
      defaultModelId?: string | null;
      titleSource?: ConversationSnapshot['conversation']['titleSource'];
    } = {},
  ): ConversationListItem {
    const existing = this.getConversation(id);
    if (existing) {
      return mapConversationListItem(existing);
    }
    return this.createConversation({...input, id});
  }

  /**
   * Returns one page of conversations, newest first.
   *
   * Pinned rows ride along on the first page only, so the sidebar's pinned
   * section is always complete and never straddles a page boundary. Everything
   * after that is keyset-paginated over the unpinned rows.
   */
  listConversations(
    input: {search?: string; limit?: number; cursor?: string} = {},
  ): ConversationPage {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const search = input.search?.trim() || undefined;
    const cursor = decodeCursor(input.cursor);

    const pinned = cursor
      ? []
      : this.queryConversations({search, pinned: true, limit: MAX_PINNED_CONVERSATIONS});
    const recent = this.queryConversations({search, pinned: false, limit, cursor});

    // Only a full page can have more behind it. A short page is the last one.
    const last = recent.length === limit ? recent[recent.length - 1] : undefined;
    return {
      conversations: [...pinned, ...recent].map(mapConversationListItem),
      nextCursor: last ? encodeCursor({updatedAt: last.updated_at, id: last.id}) : undefined,
      total: this.countConversations(search),
    };
  }

  getConversation(id: string): ConversationRow | null {
    return (
      (this.database.connection
        .prepare('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL')
        .get(id) as ConversationRow | undefined) ?? null
    );
  }

  getPiSessionBinding(id: string): PiSessionBinding | null {
    const row = this.getConversation(id);
    if (!row?.pi_session_path || !row.pi_session_id) {
      return null;
    }
    return {
      piSessionPath: row.pi_session_path,
      piSessionId: row.pi_session_id,
      activeLeafPiEntryId: row.active_leaf_pi_entry_id,
    };
  }

  getTitleSource(id: string): ConversationSnapshot['conversation']['titleSource'] | null {
    return this.getConversation(id)?.title_source ?? null;
  }

  async markInvalidPiSessionsUnavailable(): Promise<number> {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM conversations
         WHERE deleted_at IS NULL
           AND status != 'unavailable'
           AND pi_session_path IS NOT NULL`,
      )
      .all() as ConversationRow[];
    let changed = 0;
    for (const row of rows) {
      if (await piSessionFileError(row.pi_session_path)) {
        this.setConversationStatus(row.id, 'unavailable');
        changed += 1;
      }
    }
    return changed;
  }

  async markUnavailableIfPiSessionInvalid(id: string): Promise<ConversationListItem | null> {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    if (!row.pi_session_path || row.status === 'unavailable') {
      return mapConversationListItem(row);
    }
    if (!(await piSessionFileError(row.pi_session_path))) {
      return mapConversationListItem(row);
    }
    return this.setConversationStatus(id, 'unavailable');
  }

  /** Why the bound Pi session file cannot be opened, or `null` if it can. */
  async getPiSessionIssue(id: string): Promise<string | null> {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    return piSessionFileError(row.pi_session_path);
  }

  /**
   * Everything the user needs to decide between repairing, rebuilding, and
   * deleting a conversation whose Pi session file went missing.
   */
  async getConversationDiagnostics(id: string): Promise<ConversationDiagnostics | null> {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const db = this.database.connection;
    const count = (sql: string): number =>
      (db.prepare(sql).get(id) as {total: number} | undefined)?.total ?? 0;

    const reason = await piSessionFileError(row.pi_session_path);
    let sizeBytes: number | undefined;
    if (row.pi_session_path) {
      try {
        sizeBytes = (await fs.stat(row.pi_session_path)).size;
      } catch {
        sizeBytes = undefined;
      }
    }

    return {
      conversationId: row.id,
      status: row.status,
      piSessionPath: row.pi_session_path ?? undefined,
      piSessionId: row.pi_session_id ?? undefined,
      exists: reason == null,
      reason: reason ?? undefined,
      sizeBytes,
      projectionEntryCount: count(
        'SELECT COUNT(*) AS total FROM conversation_entry_projection WHERE conversation_id = ?',
      ),
      attachmentCount: count(
        'SELECT COUNT(*) AS total FROM message_attachments WHERE conversation_id = ?',
      ),
      toolAuditCount: count(
        'SELECT COUNT(*) AS total FROM tool_audit_events WHERE conversation_id = ?',
      ),
    };
  }

  /**
   * Repoints attachment rows at the entry ids a rebuilt Pi session handed out.
   *
   * Rebuilding writes fresh Pi entries, so every `pi_entry_id` sidecar rows hold
   * is stale. Attachments would otherwise stay bound to entries that no longer
   * exist and quietly vanish from the transcript.
   */
  remapAttachmentEntryIds(conversationId: string, mapping: Map<string, string>): void {
    const db = this.database.connection;
    const statement = db.prepare(
      'UPDATE message_attachments SET pi_entry_id = ? WHERE conversation_id = ? AND pi_entry_id = ?',
    );
    db.exec('BEGIN');
    try {
      for (const [previousId, nextId] of mapping) {
        statement.run(nextId, conversationId, previousId);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  getConversationEntries(id: string): ConversationEntryProjection[] {
    return this.getEntries(id);
  }

  /**
   * The projection rows on the active branch, oldest first.
   *
   * Regenerate variants sit off this path and are deliberately excluded: a
   * rebuilt Pi session is linear, so a variant would have nowhere to hang.
   */
  getActivePathEntries(id: string): ConversationEntryProjection[] {
    const row = this.getConversation(id);
    if (!row) {
      return [];
    }
    const entries = this.getEntries(id);
    const byId = new Map(entries.map(entry => [entry.piEntryId, entry] as const));
    return buildActivePathEntryIds(entries, row.active_leaf_pi_entry_id)
      .map(entryId => byId.get(entryId))
      .filter((entry): entry is ConversationEntryProjection => entry != null);
  }

  getRegenerationSource(
    conversationId: string,
    assistantPiEntryId: string,
  ): RegenerationSource | null {
    const entries = this.getEntries(conversationId);
    const byId = new Map(entries.map(entry => [entry.piEntryId, entry] as const));
    const assistantEntry = byId.get(assistantPiEntryId);
    if (!assistantEntry || assistantEntry.role !== 'assistant') {
      return null;
    }

    const directParent =
      assistantEntry.parentPiEntryId == null ? undefined : byId.get(assistantEntry.parentPiEntryId);
    let userEntry = directParent?.role === 'user' ? directParent : undefined;
    if (!userEntry) {
      const assistantIndex = entries.findIndex(entry => entry.piEntryId === assistantPiEntryId);
      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        const candidate = entries[index];
        if (candidate?.role === 'user') {
          userEntry = candidate;
          break;
        }
      }
    }
    if (!userEntry) {
      return null;
    }

    return {
      assistantEntry,
      userEntry,
      branchFromPiEntryId: userEntry.parentPiEntryId ?? null,
      regeneratesPiEntryId: assistantEntry.regeneratesPiEntryId ?? assistantEntry.piEntryId,
      displayGroupId: assistantEntry.displayGroupId ?? assistantEntry.piEntryId,
    };
  }

  createPendingAttachments(
    conversationId: string,
    attachments: CreateAttachmentInput[],
  ): AttachmentMetadata[] {
    if (attachments.length === 0) {
      return [];
    }
    const created: AttachmentMetadata[] = [];
    const db = this.database.connection;
    const insert = db.prepare(
      `INSERT INTO message_attachments (
         id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
         size_bytes, storage_path, text_content, processing_json, created_at
       ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const attachment of attachments) {
        const now = attachment.createdAt ?? new Date().toISOString();
        const id = crypto.randomUUID();
        insert.run(
          id,
          conversationId,
          attachment.uploadId,
          attachment.kind,
          attachment.name,
          attachment.mimeType ?? null,
          attachment.sizeBytes ?? null,
          attachment.storagePath ?? null,
          attachment.textContent ?? null,
          jsonOrNull(attachment.processing),
          now,
        );
        created.push({
          id,
          conversationId,
          uploadId: attachment.uploadId,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storagePath: attachment.storagePath,
          textPreview: attachment.textContent?.slice(0, 240),
          processing: attachment.processing,
          createdAt: now,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return created;
  }

  copyAttachmentsForEntries(
    sourceConversationId: string,
    targetConversationId: string,
    piEntryIds: string[],
  ): AttachmentMetadata[] {
    if (piEntryIds.length === 0) {
      return [];
    }
    const placeholders = piEntryIds.map(() => '?').join(', ');
    const rows = this.database.connection
      .prepare(
        `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
                size_bytes, storage_path, text_content, processing_json, created_at
         FROM message_attachments
         WHERE conversation_id = ? AND pi_entry_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(sourceConversationId, ...piEntryIds) as AttachmentRow[];
    if (rows.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const copied: AttachmentMetadata[] = [];
    const db = this.database.connection;
    const insert = db.prepare(
      `INSERT INTO message_attachments (
         id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
         size_bytes, storage_path, text_content, processing_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const id = crypto.randomUUID();
        insert.run(
          id,
          targetConversationId,
          row.pi_entry_id,
          row.upload_id,
          row.kind,
          row.name,
          row.mime_type,
          row.size_bytes,
          row.storage_path,
          row.text_content,
          row.processing_json,
          now,
        );
        copied.push({
          ...mapAttachmentRow({
            ...row,
            id,
            conversation_id: targetConversationId,
            created_at: now,
          }),
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    for (const piEntryId of new Set(rows.map(row => row.pi_entry_id).filter(id => id != null))) {
      this.refreshAttachmentSummary(targetConversationId, piEntryId);
    }
    return copied;
  }

  refreshAttachmentSummary(conversationId: string, piEntryId: string): void {
    const attachments = this.getAttachmentsForEntry(conversationId, piEntryId);
    this.database.connection
      .prepare(
        `UPDATE conversation_entry_projection
         SET attachment_summary_json = ?
         WHERE conversation_id = ? AND pi_entry_id = ?`,
      )
      .run(jsonOrNull(summarizeAttachments(attachments)), conversationId, piEntryId);
  }

  bindAttachmentsToEntry(
    conversationId: string,
    uploadIds: string[],
    piEntryId: string,
  ): AttachmentMetadata[] {
    if (uploadIds.length === 0) {
      return [];
    }
    const placeholders = uploadIds.map(() => '?').join(', ');
    const db = this.database.connection;
    db.prepare(
      `UPDATE message_attachments
       SET pi_entry_id = ?
       WHERE conversation_id = ? AND upload_id IN (${placeholders})`,
    ).run(piEntryId, conversationId, ...uploadIds);

    this.refreshAttachmentSummary(conversationId, piEntryId);
    return this.getAttachmentsForEntry(conversationId, piEntryId);
  }

  getStoredAttachmentsForEntry(conversationId: string, piEntryId: string): StoredAttachment[] {
    return this.getAttachmentsForEntry(conversationId, piEntryId);
  }

  getStoredAttachmentsForConversation(conversationId: string): StoredAttachment[] {
    return this.getAttachments(conversationId);
  }

  createImportedAttachments(
    conversationId: string,
    attachments: ImportedAttachmentInput[],
  ): AttachmentMetadata[] {
    if (attachments.length === 0) {
      return [];
    }
    const created: AttachmentMetadata[] = [];
    const db = this.database.connection;
    const insert = db.prepare(
      `INSERT INTO message_attachments (
         id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
         size_bytes, storage_path, text_content, processing_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec('BEGIN');
    try {
      for (const attachment of attachments) {
        const now = attachment.createdAt ?? new Date().toISOString();
        const id = crypto.randomUUID();
        insert.run(
          id,
          conversationId,
          attachment.piEntryId ?? null,
          attachment.uploadId ?? null,
          attachment.kind,
          attachment.name,
          attachment.mimeType ?? null,
          attachment.sizeBytes ?? null,
          attachment.storagePath ?? null,
          attachment.textContent ?? null,
          jsonOrNull(attachment.processing),
          now,
        );
        created.push({
          id,
          conversationId,
          piEntryId: attachment.piEntryId ?? undefined,
          uploadId: attachment.uploadId ?? undefined,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storagePath: attachment.storagePath,
          textPreview: attachment.textContent?.slice(0, 240),
          processing: attachment.processing,
          createdAt: now,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    for (const piEntryId of new Set(attachments.map(item => item.piEntryId).filter(isString))) {
      this.refreshAttachmentSummary(conversationId, piEntryId);
    }
    return created;
  }

  getSnapshot(id: string, state: AppState): ConversationSnapshot | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }

    const entries = this.getEntries(id);
    const activePathEntryIds = buildActivePathEntryIds(entries, row.active_leaf_pi_entry_id);
    const attachments = this.getAttachments(id);
    const models = buildModelList(state.models);
    const selectedModelId = state.activeModelId ?? undefined;
    const defaultModelId = row.default_model_id ?? selectedModelId;
    const defaultModel = state.models.find(model => model.id === defaultModelId);
    const unavailable = row.status === 'unavailable';

    return conversationSnapshotSchema.parse({
      conversation: {
        id: row.id,
        title: row.title,
        titleSource: row.title_source,
        pinned: Boolean(row.pinned),
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        piSessionId: row.pi_session_id ?? undefined,
        activeLeafPiEntryId: row.active_leaf_pi_entry_id ?? undefined,
        defaultModelId: defaultModelId ?? undefined,
        parentConversationId: row.parent_conversation_id ?? undefined,
        forkedFromPiEntryId: row.forked_from_pi_entry_id ?? undefined,
        forkKind: row.fork_kind ?? undefined,
        reasoningLevel: normalizeReasoningLevel(row.reasoning_level),
      },
      entries,
      activePathEntryIds,
      attachments,
      context: buildContextUsage(
        entries,
        defaultModel?.params.contextSize,
        contextUsageFromRow(row.context_usage_json),
      ),
      models: {
        selectedModelId,
        defaultModelId: defaultModelId ?? undefined,
        available: models,
      },
      capabilities: {
        canSend: !unavailable && state.runtime != null,
        canAbort: row.status === 'running' || row.status === 'compacting',
        canCompact: row.status === 'ready',
        canFork: entries.length > 0 && !unavailable,
        canRepair: unavailable,
        canAttachImages: false,
        canAttachText: true,
      },
      errors: unavailable
        ? [
            {
              code: 'session_unavailable',
              message: 'The conversation session is unavailable.',
            },
          ]
        : [],
    });
  }

  patchConversation(
    id: string,
    input: {
      title?: string;
      pinned?: boolean;
      defaultModelId?: string | null;
      status?: ConversationStatus;
    },
  ): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const nextStatus = input.status ?? row.status;
    assertConversationTransition(row.status, nextStatus);
    const next: ConversationRow = {
      ...row,
      title: input.title ?? row.title,
      title_source: input.title == null ? row.title_source : 'user',
      pinned: input.pinned == null ? row.pinned : input.pinned ? 1 : 0,
      default_model_id:
        input.defaultModelId === undefined ? row.default_model_id : input.defaultModelId,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    };
    this.database.connection
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = ?, pinned = ?, default_model_id = ?,
             status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.title_source,
        next.pinned,
        next.default_model_id,
        next.status,
        next.updated_at,
        id,
      );
    this.upsertSearch(id, next.title);
    return mapConversationListItem(next);
  }

  setGeneratedTitle(id: string, title: string): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row || row.title_source !== 'fallback') {
      return null;
    }
    const next: ConversationRow = {
      ...row,
      title,
      title_source: 'generated',
      updated_at: new Date().toISOString(),
    };
    this.database.connection
      .prepare(
        `UPDATE conversations
         SET title = ?, title_source = ?, updated_at = ?
         WHERE id = ? AND title_source = 'fallback'`,
      )
      .run(next.title, next.title_source, next.updated_at, id);
    this.upsertSearch(id, title);
    return mapConversationListItem(next);
  }

  setConversationStatus(id: string, status: ConversationStatus): ConversationListItem | null {
    return this.patchConversation(id, {status});
  }

  attachPiSession(id: string, binding: PiSessionBinding): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const next: ConversationRow = {
      ...row,
      pi_session_path: binding.piSessionPath,
      pi_session_id: binding.piSessionId,
      active_leaf_pi_entry_id: binding.activeLeafPiEntryId ?? row.active_leaf_pi_entry_id,
      updated_at: new Date().toISOString(),
    };
    this.database.connection
      .prepare(
        `UPDATE conversations
         SET pi_session_path = ?, pi_session_id = ?, active_leaf_pi_entry_id = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.pi_session_path,
        next.pi_session_id,
        next.active_leaf_pi_entry_id,
        next.updated_at,
        id,
      );
    return mapConversationListItem(next);
  }

  getReasoningLevel(id: string): ReasoningLevel {
    const row = this.getConversation(id);
    return normalizeReasoningLevel(row?.reasoning_level);
  }

  setReasoningLevel(id: string, level: ReasoningLevel): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const next: ConversationRow = {...row, reasoning_level: level};
    this.database.connection
      .prepare('UPDATE conversations SET reasoning_level = ? WHERE id = ?')
      .run(level, id);
    return mapConversationListItem(next);
  }

  setConversationContextUsage(
    id: string,
    context: ConversationContextUsage | null,
  ): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const next: ConversationRow = {
      ...row,
      context_usage_json: context ? JSON.stringify(context) : null,
      updated_at: new Date().toISOString(),
    };
    this.database.connection
      .prepare(
        `UPDATE conversations
         SET context_usage_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(next.context_usage_json, next.updated_at, id);
    return mapConversationListItem(next);
  }

  replaceConversationProjection(
    id: string,
    input: {
      piSessionPath?: string;
      piSessionId?: string;
      activeLeafPiEntryId?: string | null;
      lastSyncedPiEntryId?: string | null;
      status?: ConversationStatus;
      entries: SyncConversationEntry[];
    },
  ): ConversationListItem | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const nextStatus = input.status ?? row.status;
    assertConversationTransition(row.status, nextStatus);
    const now = new Date().toISOString();
    const next: ConversationRow = {
      ...row,
      pi_session_path: input.piSessionPath ?? row.pi_session_path,
      pi_session_id: input.piSessionId ?? row.pi_session_id,
      active_leaf_pi_entry_id: input.activeLeafPiEntryId ?? row.active_leaf_pi_entry_id,
      last_synced_pi_entry_id: input.lastSyncedPiEntryId ?? row.last_synced_pi_entry_id,
      status: nextStatus,
      updated_at: now,
    };

    const db = this.database.connection;
    const existingEntries = new Map(
      this.getEntries(id).map(entry => [entry.piEntryId, entry] as const),
    );
    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE conversations
         SET pi_session_path = ?, pi_session_id = ?, active_leaf_pi_entry_id = ?,
             last_synced_pi_entry_id = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.pi_session_path,
        next.pi_session_id,
        next.active_leaf_pi_entry_id,
        next.last_synced_pi_entry_id,
        next.status,
        next.updated_at,
        id,
      );
      db.prepare('DELETE FROM conversation_entry_projection WHERE conversation_id = ?').run(id);
      for (const entry of input.entries) {
        const existing = existingEntries.get(entry.piEntryId);
        this.upsertProjection(id, {
          ...entry,
          performance: entry.performance ?? existing?.performance,
          toolCalls: entry.toolCalls ?? existing?.toolCalls,
          attachmentSummary: entry.attachmentSummary ?? existing?.attachmentSummary,
          regeneratesPiEntryId: entry.regeneratesPiEntryId ?? existing?.regeneratesPiEntryId,
          displayGroupId: entry.displayGroupId ?? existing?.displayGroupId,
        });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return mapConversationListItem(next);
  }

  clearConversationProjection(id: string): void {
    const db = this.database.connection;
    db.prepare('DELETE FROM conversation_entry_projection WHERE conversation_id = ?').run(id);
    db.prepare(
      `UPDATE conversations
       SET active_leaf_pi_entry_id = NULL, last_synced_pi_entry_id = NULL,
           pi_session_path = NULL, pi_session_id = NULL, status = 'ready',
           context_usage_json = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), id);
  }

  hardDeleteConversation(id: string): boolean {
    const result = this.database.connection
      .prepare('DELETE FROM conversations WHERE id = ?')
      .run(id);
    if (hasConversationSearch(this.database.connection)) {
      this.database.connection
        .prepare('DELETE FROM conversation_search WHERE conversation_id = ?')
        .run(id);
    }
    return result.changes > 0;
  }

  getConversationDeleteResources(id: string): ConversationDeleteResources | null {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    const attachmentRows = this.database.connection
      .prepare(
        `SELECT DISTINCT storage_path
         FROM message_attachments
         WHERE conversation_id = ? AND storage_path IS NOT NULL`,
      )
      .all(id) as Array<{storage_path: string}>;
    const attachmentStoragePaths = attachmentRows
      .map(item => item.storage_path)
      .filter(
        storagePath => !this.isAttachmentStorageReferencedByOtherConversation(storagePath, id),
      );

    return {
      piSessionPaths: row.pi_session_path ? [row.pi_session_path] : [],
      attachmentStoragePaths,
    };
  }

  getAllConversationDeleteResources(): ConversationDeleteResources {
    const piRows = this.database.connection
      .prepare(
        `SELECT DISTINCT pi_session_path
         FROM conversations
         WHERE pi_session_path IS NOT NULL`,
      )
      .all() as Array<{pi_session_path: string}>;
    const attachmentRows = this.database.connection
      .prepare(
        `SELECT DISTINCT storage_path
         FROM message_attachments
         WHERE storage_path IS NOT NULL`,
      )
      .all() as Array<{storage_path: string}>;
    return {
      piSessionPaths: piRows.map(row => row.pi_session_path),
      attachmentStoragePaths: attachmentRows.map(row => row.storage_path),
    };
  }

  getReferencedAttachmentStoragePaths(): Set<string> {
    const rows = this.database.connection
      .prepare(
        `SELECT DISTINCT storage_path
         FROM message_attachments
         WHERE storage_path IS NOT NULL`,
      )
      .all() as Array<{storage_path: string}>;
    return new Set(rows.map(row => row.storage_path));
  }

  hardDeleteAllConversations(): void {
    const db = this.database.connection;
    db.exec('DELETE FROM conversations;');
    if (hasConversationSearch(db)) {
      db.exec('DELETE FROM conversation_search;');
    }
  }

  /**
   * Mirrors a legacy `state.json` chat into the default conversation.
   *
   * Returns null when there is no legacy chat to migrate and the conversation
   * does not exist. Read paths such as `GET /api/conversations` call this, so
   * creating a placeholder here would resurrect the conversation immediately
   * after the user deletes it.
   */
  syncLegacyDefaultConversationFromState(
    state: AppState,
    options: {forceLegacyProjection?: boolean} = {},
  ): ConversationListItem | null {
    const now = new Date().toISOString();
    const title = state.chat[0]?.content.slice(0, 80) || 'Legacy chat';
    const existing = this.getConversation(LEGACY_DEFAULT_CONVERSATION_ID);
    if (!existing && state.chat.length === 0) {
      return null;
    }
    if (existing?.pi_session_id && !options.forceLegacyProjection) {
      return mapConversationListItem(existing);
    }
    const row: ConversationRow = {
      id: LEGACY_DEFAULT_CONVERSATION_ID,
      title: existing?.title ?? title,
      title_source: existing?.title_source ?? 'fallback',
      pinned: existing?.pinned ?? 0,
      pi_session_path: existing?.pi_session_path ?? null,
      pi_session_id: existing?.pi_session_id ?? null,
      active_leaf_pi_entry_id: state.chat.at(-1)?.id ?? null,
      last_synced_pi_entry_id: state.chat.at(-1)?.id ?? null,
      default_model_id: existing?.default_model_id ?? state.activeModelId,
      parent_conversation_id: existing?.parent_conversation_id ?? null,
      forked_from_pi_entry_id: existing?.forked_from_pi_entry_id ?? null,
      fork_kind: existing?.fork_kind ?? null,
      context_usage_json: existing?.context_usage_json ?? null,
      reasoning_level: normalizeReasoningLevel(existing?.reasoning_level),
      status: existing?.status ?? 'ready',
      created_at: existing?.created_at ?? now,
      updated_at: now,
      deleted_at: null,
    };

    if (existing) {
      this.database.connection
        .prepare(
          `UPDATE conversations
           SET title = ?, title_source = ?, pinned = ?, active_leaf_pi_entry_id = ?,
               last_synced_pi_entry_id = ?, default_model_id = ?, status = ?,
               updated_at = ?, deleted_at = NULL
           WHERE id = ?`,
        )
        .run(
          row.title,
          row.title_source,
          row.pinned,
          row.active_leaf_pi_entry_id,
          row.last_synced_pi_entry_id,
          row.default_model_id,
          row.status,
          row.updated_at,
          row.id,
        );
    } else {
      this.insertConversation(row);
    }

    this.database.connection
      .prepare('DELETE FROM conversation_entry_projection WHERE conversation_id = ?')
      .run(LEGACY_DEFAULT_CONVERSATION_ID);
    for (let index = 0; index < state.chat.length; index += 1) {
      this.upsertChatMessage(
        LEGACY_DEFAULT_CONVERSATION_ID,
        state.chat[index]!,
        state.chat[index - 1]?.id,
      );
    }
    this.upsertSearch(row.id, row.title);
    return mapConversationListItem(row);
  }

  private insertConversation(row: ConversationRow): void {
    this.database.connection
      .prepare(
        `INSERT INTO conversations (
          id, title, title_source, pinned, pi_session_path, pi_session_id,
          active_leaf_pi_entry_id, last_synced_pi_entry_id, default_model_id,
          parent_conversation_id, forked_from_pi_entry_id, fork_kind,
          context_usage_json, reasoning_level, status, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.title,
        row.title_source,
        row.pinned,
        row.pi_session_path,
        row.pi_session_id,
        row.active_leaf_pi_entry_id,
        row.last_synced_pi_entry_id,
        row.default_model_id,
        row.parent_conversation_id,
        row.forked_from_pi_entry_id,
        row.fork_kind,
        row.context_usage_json,
        row.reasoning_level,
        row.status,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      );
  }

  private upsertChatMessage(
    conversationId: string,
    message: ChatMessage,
    parentPiEntryId?: string,
  ): void {
    this.upsertProjection(conversationId, {
      piEntryId: message.id,
      parentPiEntryId,
      entryType: 'message',
      role: message.role,
      text: message.content,
      createdAt: message.createdAt,
      modelId: message.modelId,
      modelRuntimeId: message.modelRuntimeId,
      modelAliasSnapshot: message.modelAliasSnapshot,
      performance: message.performance,
      toolCalls: message.toolCalls,
      regeneratesPiEntryId: message.regeneratesPiEntryId,
      displayGroupId: message.displayGroupId ?? message.id,
    });
  }

  private upsertProjection(conversationId: string, entry: SyncConversationEntry): void {
    this.database.connection
      .prepare(
        `INSERT INTO conversation_entry_projection (
           conversation_id, pi_entry_id, parent_pi_entry_id, entry_type, role,
           text_preview, created_at, model_id, model_runtime_id, model_alias_snapshot,
           performance_json, tool_calls_json, attachment_summary_json,
           regenerates_pi_entry_id, display_group_id, reasoning_text
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, pi_entry_id) DO UPDATE SET
           parent_pi_entry_id = excluded.parent_pi_entry_id,
           entry_type = excluded.entry_type,
           role = excluded.role,
           text_preview = excluded.text_preview,
           created_at = excluded.created_at,
           model_id = excluded.model_id,
           model_runtime_id = excluded.model_runtime_id,
           model_alias_snapshot = excluded.model_alias_snapshot,
           performance_json = excluded.performance_json,
           tool_calls_json = excluded.tool_calls_json,
           attachment_summary_json = excluded.attachment_summary_json,
           regenerates_pi_entry_id = excluded.regenerates_pi_entry_id,
           display_group_id = excluded.display_group_id,
           reasoning_text = excluded.reasoning_text`,
      )
      .run(
        conversationId,
        entry.piEntryId,
        entry.parentPiEntryId ?? null,
        entry.entryType,
        entry.role ?? null,
        entry.text,
        entry.createdAt,
        entry.modelId ?? null,
        entry.modelRuntimeId ?? null,
        entry.modelAliasSnapshot ?? null,
        jsonOrNull(entry.performance),
        jsonOrNull(entry.toolCalls),
        jsonOrNull(entry.attachmentSummary),
        entry.regeneratesPiEntryId ?? null,
        entry.displayGroupId ?? entry.piEntryId,
        entry.reasoning?.trim() ? entry.reasoning : null,
      );
  }

  private getEntries(conversationId: string): ConversationEntryProjection[] {
    const rows = this.database.connection
      .prepare(
        `SELECT * FROM conversation_entry_projection
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as EntryRow[];

    return rows.map(row => ({
      conversationId: row.conversation_id,
      piEntryId: row.pi_entry_id,
      parentPiEntryId: row.parent_pi_entry_id ?? undefined,
      entryType: row.entry_type,
      role: row.role ?? undefined,
      textPreview: row.text_preview ?? undefined,
      createdAt: row.created_at,
      modelId: row.model_id ?? undefined,
      modelRuntimeId: row.model_runtime_id ?? undefined,
      modelAliasSnapshot: row.model_alias_snapshot ?? undefined,
      performance: sanitizeStoredPerformance(parseJson(row.performance_json)),
      toolCalls: parseJson(row.tool_calls_json),
      attachmentSummary: parseJson(row.attachment_summary_json),
      regeneratesPiEntryId: row.regenerates_pi_entry_id ?? undefined,
      displayGroupId: row.display_group_id ?? undefined,
      reasoning: row.reasoning_text ?? undefined,
    }));
  }

  private getAttachments(conversationId: string): AttachmentMetadata[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
                size_bytes, storage_path, text_content, processing_json, created_at
         FROM message_attachments
         WHERE conversation_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId) as AttachmentRow[];

    return rows.map(mapAttachmentRow);
  }

  private getAttachmentsForEntry(conversationId: string, piEntryId: string): StoredAttachment[] {
    const rows = this.database.connection
      .prepare(
        `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
                size_bytes, storage_path, text_content, processing_json, created_at
         FROM message_attachments
         WHERE conversation_id = ? AND pi_entry_id = ?
         ORDER BY created_at ASC`,
      )
      .all(conversationId, piEntryId) as AttachmentRow[];

    return rows.map(mapAttachmentRow);
  }

  /**
   * How many conversations match, across every page.
   *
   * The sidebar shows a window; "512 conversations stored locally" must count
   * the ones that were never fetched.
   */
  private countConversations(search: string | undefined): number {
    const db = this.database.connection;
    if (search && hasConversationSearch(db)) {
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS total
             FROM conversation_search
             JOIN conversations ON conversations.id = conversation_search.conversation_id
             WHERE conversation_search MATCH ? AND conversations.deleted_at IS NULL`,
          )
          .get(search) as {total: number};
        return row.total;
      } catch {
        // Same stricter-syntax fallback as the page query below.
      }
    }
    if (search) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total FROM conversations
           WHERE deleted_at IS NULL AND title LIKE ? ESCAPE '\\'`,
        )
        .get(`%${escapeLike(search)}%`) as {total: number};
      return row.total;
    }
    const row = db
      .prepare('SELECT COUNT(*) AS total FROM conversations WHERE deleted_at IS NULL')
      .get() as {total: number};
    return row.total;
  }

  /**
   * One page of rows from a single pinned group, newest first.
   *
   * FTS5 is only ever a filter here; the ordering always comes from
   * `conversations`. Paginating by FTS `rank` would overlap pages, because rank
   * shifts as rows are inserted into the index.
   */
  private queryConversations(input: {
    search?: string;
    pinned: boolean;
    limit: number;
    cursor?: ConversationCursor | null;
  }): ConversationRow[] {
    const db = this.database.connection;
    const conditions = ['conversations.deleted_at IS NULL', 'conversations.pinned = ?'];
    const params: (string | number)[] = [input.pinned ? 1 : 0];

    if (input.cursor) {
      conditions.push('(conversations.updated_at, conversations.id) < (?, ?)');
      params.push(input.cursor.updatedAt, input.cursor.id);
    }

    const tail = `ORDER BY conversations.updated_at DESC, conversations.id DESC LIMIT ?`;

    if (input.search && hasConversationSearch(db)) {
      try {
        return db
          .prepare(
            `SELECT conversations.*
             FROM conversation_search
             JOIN conversations ON conversations.id = conversation_search.conversation_id
             WHERE conversation_search MATCH ? AND ${conditions.join(' AND ')}
             ${tail}`,
          )
          .all(input.search, ...params, input.limit) as ConversationRow[];
      } catch {
        // FTS query syntax is stricter than ordinary user search input. Fall
        // back to LIKE rather than failing the list endpoint.
      }
    }

    if (input.search) {
      conditions.push(`conversations.title LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(input.search)}%`);
    }

    return db
      .prepare(
        `SELECT conversations.* FROM conversations WHERE ${conditions.join(' AND ')} ${tail}`,
      )
      .all(...params, input.limit) as ConversationRow[];
  }

  private upsertSearch(conversationId: string, title: string): void {
    const db = this.database.connection;
    if (!hasConversationSearch(db)) {
      return;
    }
    db.prepare('DELETE FROM conversation_search WHERE conversation_id = ?').run(conversationId);
    db.prepare('INSERT INTO conversation_search(conversation_id, title) VALUES (?, ?)').run(
      conversationId,
      title,
    );
  }

  private isAttachmentStorageReferencedByOtherConversation(
    storagePath: string,
    conversationId: string,
  ): boolean {
    const row = this.database.connection
      .prepare(
        `SELECT COUNT(*) AS count
         FROM message_attachments
         WHERE storage_path = ? AND conversation_id != ?`,
      )
      .get(storagePath, conversationId) as {count: number};
    return row.count > 0;
  }
}

function mapAttachmentRow(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    piEntryId: row.pi_entry_id ?? undefined,
    uploadId: row.upload_id ?? undefined,
    kind: normalizeAttachmentKind(row.kind),
    name: row.name,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    storagePath: row.storage_path ?? undefined,
    textPreview: row.text_content?.slice(0, 240),
    textContent: row.text_content ?? undefined,
    processing: parseJson(row.processing_json),
    createdAt: row.created_at,
  };
}

function normalizeAttachmentKind(kind: string): ChatAttachmentKind {
  if (kind === 'pdf' || kind === 'image' || kind === 'text') {
    return kind;
  }
  return 'text';
}

function summarizeAttachments(attachments: AttachmentMetadata[]): unknown {
  return {
    count: attachments.length,
    items: attachments.map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}

function mapConversationListItem(row: ConversationRow): ConversationListItem {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    pinned: Boolean(row.pinned),
    status: row.status,
    updatedAt: row.updated_at,
    defaultModelId: row.default_model_id ?? undefined,
  };
}

function buildActivePathEntryIds(
  entries: ConversationEntryProjection[],
  activeLeafPiEntryId: string | null,
): string[] {
  if (!activeLeafPiEntryId) {
    return entries.map(entry => entry.piEntryId);
  }
  const byId = new Map(entries.map(entry => [entry.piEntryId, entry] as const));
  const path: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = activeLeafPiEntryId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (!entry) {
      break;
    }
    path.push(entry.piEntryId);
    cursor = entry.parentPiEntryId;
  }
  return path.length > 0 ? path.reverse() : entries.map(entry => entry.piEntryId);
}

function buildModelList(models: ConfiguredModel[]): ModelListItem[] {
  return models.map(model => ({
    id: model.id,
    alias: model.name,
  }));
}

function buildContextUsage(
  entries: ConversationEntryProjection[],
  totalTokens?: number,
  storedContext?: ConversationContextUsage | null,
): ConversationContextUsage {
  const totalTokenCount = positiveInteger(totalTokens);
  let derivedContext: ConversationContextUsage | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== 'assistant') {
      continue;
    }
    const context = contextUsageFromPerformance(entry.performance, entry.createdAt);
    if (context) {
      derivedContext = {
        ...context,
        totalTokens: totalTokenCount ?? context.totalTokens,
      };
      break;
    }
  }

  const mergedStored = storedContext
    ? {
        ...storedContext,
        totalTokens: totalTokenCount ?? storedContext.totalTokens,
      }
    : null;
  if (derivedContext && mergedStored) {
    return isContextNewer(mergedStored, derivedContext) ? mergedStored : derivedContext;
  }
  if (derivedContext) {
    return derivedContext;
  }
  if (mergedStored) {
    return mergedStored;
  }
  return {
    totalTokens: totalTokenCount,
  };
}

function contextUsageFromRow(value: string | null): ConversationContextUsage | null {
  const parsed = parseJson(value);
  const result = conversationContextUsageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function isContextNewer(
  candidate: ConversationContextUsage,
  current: ConversationContextUsage,
): boolean {
  const candidateTime = candidate.updatedAt ? Date.parse(candidate.updatedAt) : Number.NaN;
  const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
  if (Number.isNaN(candidateTime)) {
    return false;
  }
  if (Number.isNaN(currentTime)) {
    return true;
  }
  return candidateTime >= currentTime;
}

function contextUsageFromPerformance(
  performance: unknown,
  updatedAt: string,
): ConversationContextUsage | null {
  if (!performance || typeof performance !== 'object') {
    return null;
  }
  const data = performance as {
    source?: unknown;
    prompt?: unknown;
    generation?: unknown;
    generatedTokens?: unknown;
  };
  const prompt = metricObject(data.prompt);
  const generation = metricObject(data.generation);
  const promptTokens = positiveInteger(prompt?.totalTokens) ?? positiveInteger(prompt?.tokens);
  if (promptTokens == null) {
    return null;
  }
  const generationTokens =
    positiveInteger(generation?.tokens) ?? positiveInteger(data.generatedTokens) ?? 0;

  return {
    usedTokens: promptTokens + generationTokens,
    source: data.source === 'llamacpp-timings' ? 'timings' : 'prompt_progress',
    updatedAt,
  };
}

function metricObject(value: unknown): {
  tokens?: unknown;
  totalTokens?: unknown;
} | null {
  return value && typeof value === 'object' ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function jsonOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

function parseJson(value: string | null): unknown {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function hasConversationSearch(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_search'")
    .get() as {name: string} | undefined;
  return row != null;
}

async function piSessionFileError(sessionPath: string | null): Promise<string | null> {
  if (!sessionPath) {
    return null;
  }
  try {
    const stat = await fs.stat(sessionPath);
    if (!stat.isFile()) {
      return 'Pi session path is not a file.';
    }
    const firstLine = await readFirstLine(sessionPath);
    if (!firstLine) {
      return 'Pi session file is empty.';
    }
    // These strings reach the user in the repair dialog, so a raw parser message
    // like `Unexpected token 'o', "not-json" is not valid JSON` will not do.
    let header: unknown;
    try {
      header = JSON.parse(firstLine) as unknown;
    } catch {
      return 'Pi session file is not valid JSON.';
    }
    if (
      !header ||
      typeof header !== 'object' ||
      (header as {type?: unknown}).type !== 'session' ||
      typeof (header as {id?: unknown}).id !== 'string'
    ) {
      return 'Pi session file is missing a valid session header.';
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'Pi session file is missing.';
    }
    return error instanceof Error ? error.message : String(error);
  }
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = chunk.search(/\r?\n/);
    return (newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk).trim();
  } finally {
    await handle.close();
  }
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, character => `\\${character}`);
}
