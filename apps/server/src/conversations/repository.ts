import crypto from 'node:crypto';

import type {
  AttachmentMetadata,
  ConversationContextUsage,
  ConversationEntryProjection,
  ConversationListItem,
  ConversationListResponse,
  ConversationSnapshot,
  ConversationStatus,
  ModelListItem,
} from '../contracts/conversations.ts';
import {
  assertConversationTransition,
  conversationSnapshotSchema,
} from '../contracts/conversations.ts';
import type {ChatAttachmentKind} from '../contracts/contracts.ts';
import type {ReasoningLevel} from '../contracts/reasoning.ts';
import {
  DEFAULT_NEW_CONVERSATION_REASONING_LEVEL,
  normalizeReasoningLevel,
} from '../contracts/reasoning.ts';
import type {AppDatabase} from '../db/database';
import {buildConversationMessages} from '../contracts/messages.ts';
import {ModelCacheRepository} from '../models/cache';
import {effectiveContextWindow} from '../llama/contextWindow';
import type {AppState, ChatMessage, ConfiguredModel} from '../lib/types';
import {buildContextUsage, contextUsageFromRow} from './context';
import type {ConversationRow, SyncConversationEntry} from './rows';
import {
  insertConversationRow,
  isString,
  jsonOrNull,
  mapConversationListItem,
  parseJson,
  selectConversationEntries,
  upsertConversationEntryRow,
} from './rows';
import {
  MAX_PINNED_CONVERSATIONS,
  countConversationRows,
  decodeCursor,
  encodeCursor,
  hasConversationSearch,
  queryConversationRows,
  upsertConversationSearch,
} from './search';
import type {ConversationDiagnostics} from './sessionFile';
import {
  collectConversationDiagnostics,
  piSessionFileError,
  selectConversationsWithPiSession,
} from './sessionFile';

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

// The list-item and page shapes live in `contracts/` as zod schemas
// (conversationListItemSchema / conversationListResponseSchema) so the served
// OpenAPI can carry them and the Flutter client can codegen them. Re-exported
// here so existing server call sites keep their import paths.
export type {ConversationListItem};
export type ConversationPage = ConversationListResponse;

// The row shapes and their statements live in `rows.ts`. Re-exported here so the
// Pi harness, the archive code and the tests keep their import paths.
export type {ConversationRow, SyncConversationEntry};

export type PiSessionBinding = {
  piSessionPath: string;
  piSessionId: string;
  activeLeafPiEntryId?: string | null;
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

// The Pi session file's own checks live in `sessionFile.ts`.
export type {ConversationDiagnostics};

export class ConversationRepository {
  /** Answers "can this model see images?" without a live router. */
  private readonly modelCache: ModelCacheRepository;

  constructor(private readonly database: AppDatabase) {
    this.modelCache = new ModelCacheRepository(database);
  }

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

    const db = this.database.connection;
    const pinned = cursor
      ? []
      : queryConversationRows(db, {search, pinned: true, limit: MAX_PINNED_CONVERSATIONS});
    const recent = queryConversationRows(db, {search, pinned: false, limit, cursor});

    // Only a full page can have more behind it. A short page is the last one.
    const last = recent.length === limit ? recent[recent.length - 1] : undefined;
    return {
      conversations: [...pinned, ...recent].map(mapConversationListItem),
      nextCursor: last ? encodeCursor({updatedAt: last.updated_at, id: last.id}) : undefined,
      total: countConversationRows(db, search),
    };
  }

  getConversation(id: string): ConversationRow | null {
    return (
      (this.database.connection.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
        | ConversationRow
        | undefined) ?? null
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
    const rows = selectConversationsWithPiSession(this.database.connection);
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

  async getConversationDiagnostics(id: string): Promise<ConversationDiagnostics | null> {
    const row = this.getConversation(id);
    if (!row) {
      return null;
    }
    return collectConversationDiagnostics(this.database.connection, row);
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
    db.run('BEGIN');
    try {
      for (const [previousId, nextId] of mapping) {
        statement.run(nextId, conversationId, previousId);
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
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
    db.run('BEGIN');
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
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
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
    db.run('BEGIN');
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
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
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
    db.run('BEGIN');
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
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
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
      // The rules that turn entries into renderable messages are shared, so a
      // second client renders exactly what the browser does.
      messages: buildConversationMessages(entries, attachments),
      activePathEntryIds,
      attachments,
      context: buildContextUsage(
        entries,
        // What llama.cpp reports, not what `models.ini` asked for. `undefined`
        // leaves the context bar without a total rather than claiming a
        // percentage of a window nobody has measured.
        (defaultModel && effectiveContextWindow(defaultModel, this.modelCache)) ?? undefined,
        contextUsageFromRow(row.context_usage_json),
      ),
      models: {
        selectedModelId,
        defaultModelId: defaultModelId ?? undefined,
        available: models,
      },
      capabilities: {
        // Conversation-level only. `state.runtime` is runtime state the client
        // owns, and a `ready` conversation is by definition not unavailable.
        canSend: row.status === 'ready',
        canAbort: row.status === 'running' || row.status === 'compacting',
        canCompact: row.status === 'ready',
        canFork: entries.length > 0 && !unavailable,
        canRepair: unavailable,
        canAttachImages: defaultModelId ? this.modelCache.getVisionSupport(defaultModelId) : null,
        canReason: defaultModelId ? this.modelCache.getReasoningSupport(defaultModelId) : null,
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
    const nextPiSessionPath = input.piSessionPath ?? row.pi_session_path;
    const nextPiSessionId = input.piSessionId ?? row.pi_session_id;
    const nextLeaf = input.activeLeafPiEntryId ?? row.active_leaf_pi_entry_id;

    // Opening a conversation rebuilds its projection from Pi, so this runs on a
    // read, and a read must not reorder the sidebar: `updated_at` is the list's
    // sort key and its keyset cursor, and stamping it here sent whichever
    // conversation you last opened to the top.
    //
    // Pi's session file is append-only, so the leaf moves whenever a conversation
    // gains an entry -- a message, a regenerate, a compaction. A sync that finds
    // the same leaf found no news, whatever else it rewrote into the projection:
    // the variant groups a metadata-less rebuild rediscovers, and the `ready` a
    // stale `running` row recovers to after a restart, are not activity. Runs bump
    // `updated_at` through `setConversationStatus` at their start and end, so an
    // answer in flight still rises to the top on its own.
    const changed =
      nextLeaf !== row.active_leaf_pi_entry_id ||
      nextPiSessionPath !== row.pi_session_path ||
      nextPiSessionId !== row.pi_session_id;

    const next: ConversationRow = {
      ...row,
      pi_session_path: nextPiSessionPath,
      pi_session_id: nextPiSessionId,
      active_leaf_pi_entry_id: nextLeaf,
      last_synced_pi_entry_id: input.lastSyncedPiEntryId ?? row.last_synced_pi_entry_id,
      status: nextStatus,
      updated_at: changed ? new Date().toISOString() : row.updated_at,
    };

    const db = this.database.connection;
    const existingEntries = new Map(
      this.getEntries(id).map(entry => [entry.piEntryId, entry] as const),
    );
    db.run('BEGIN');
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
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
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
    db.run('DELETE FROM conversations;');
    if (hasConversationSearch(db)) {
      db.run('DELETE FROM conversation_search;');
    }
  }

  private insertConversation(row: ConversationRow): void {
    insertConversationRow(this.database.connection, row);
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
    upsertConversationEntryRow(this.database.connection, conversationId, entry);
  }

  private getEntries(conversationId: string): ConversationEntryProjection[] {
    return selectConversationEntries(this.database.connection, conversationId);
  }

  /**
   * One attachment by id, for serving its bytes.
   *
   * The id is the only thing the client has: a transcript renders what the snapshot
   * gave it, and the snapshot carries attachment metadata but not the bytes -- the
   * bytes are on the server, and on a phone they always will be.
   */
  getAttachmentById(id: string): AttachmentMetadata | null {
    const row = this.database.connection
      .prepare(
        `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
                size_bytes, storage_path, text_content, processing_json, created_at
         FROM message_attachments
         WHERE id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
    return row ? mapAttachmentRow(row) : null;
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

  private upsertSearch(conversationId: string, title: string): void {
    upsertConversationSearch(this.database.connection, conversationId, title);
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
