import type {Database} from 'bun:sqlite';

import type {
  ConversationEntryProjection,
  ConversationListItem,
  ConversationSnapshot,
  ConversationStatus,
} from '../contracts/conversations.ts';
import type {ReasoningLevel} from '../contracts/reasoning.ts';
import {sanitizeStoredPerformance} from '../llama/throughput';
import type {ChatMessage} from '../lib/types';

/**
 * The SQLite row shapes, and the statements that read and write them.
 *
 * A row is not a payload: `conversations` and `conversation_entry_projection` are
 * snake_case and nullable everywhere, while the wire contract is camelCase and uses
 * `undefined`. Everything that crosses that boundary crosses it here, so a column
 * rename is one file rather than a grep.
 *
 * The repository keeps the business rules -- status transitions, `updated_at`
 * stamping, the append-only projection rebuild -- and calls into this for the SQL.
 */

export type ConversationRow = {
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
};

export type EntryRow = {
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

export function insertConversationRow(db: Database, row: ConversationRow): void {
  db.prepare(
    `INSERT INTO conversations (
      id, title, title_source, pinned, pi_session_path, pi_session_id,
      active_leaf_pi_entry_id, last_synced_pi_entry_id, default_model_id,
      parent_conversation_id, forked_from_pi_entry_id, fork_kind,
      context_usage_json, reasoning_level, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
}

export function upsertConversationEntryRow(
  db: Database,
  conversationId: string,
  entry: SyncConversationEntry,
): void {
  db.prepare(
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
  ).run(
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

export function selectConversationEntries(
  db: Database,
  conversationId: string,
): ConversationEntryProjection[] {
  const rows = db
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

export function mapConversationListItem(row: ConversationRow): ConversationListItem {
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

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function jsonOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return JSON.stringify(value);
}

export function parseJson(value: string | null): unknown {
  if (value == null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
