import type {
  AttachmentMetadata,
  ConversationEntryProjection,
  ConversationSnapshot,
  ModelListItem,
} from '../contracts/conversations.ts';
import {conversationSnapshotSchema} from '../contracts/conversations.ts';
import {buildConversationMessages} from '../contracts/messages.ts';
import {normalizeReasoningLevel} from '../contracts/reasoning.ts';
import {effectiveContextWindow} from '../llama/contextWindow';
import type {ModelCacheRepository} from '../models/cache';
import type {AppState, ConfiguredModel} from '../lib/types';
import {buildContextUsage, contextUsageFromRow} from './context';
import type {ConversationRow} from './rows';

/**
 * The snapshot a client renders: one conversation, its messages, its context, and what it
 * is currently allowed to do.
 *
 * It is assembled from rows the repository read, and it reads no rows itself -- the
 * projection is already the active branch by the time it arrives here. The rules that turn
 * entries into renderable messages live in `contracts/messages.ts`, shared rather than
 * re-derived, so a second client renders exactly what the first one does.
 */

export function buildConversationSnapshot(input: {
  row: ConversationRow;
  entries: ConversationEntryProjection[];
  attachments: AttachmentMetadata[];
  state: AppState;
  modelCache: ModelCacheRepository;
}): ConversationSnapshot {
  const {row, entries, attachments, state, modelCache} = input;
  const activePathEntryIds = buildActivePathEntryIds(entries, row.active_leaf_pi_entry_id);
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
      (defaultModel && effectiveContextWindow(defaultModel, modelCache)) ?? undefined,
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
      canAttachImages: defaultModelId ? modelCache.getVisionSupport(defaultModelId) : null,
      canReason: defaultModelId ? modelCache.getReasoningSupport(defaultModelId) : null,
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

export function buildActivePathEntryIds(
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
