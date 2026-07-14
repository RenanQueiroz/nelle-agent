/**
 * Pi's session file, read back into the rows a client renders.
 *
 * `getBranch()` walks the active path and nothing else, so a projection rebuilt from it alone
 * would lose every answer a regenerate branched away from -- and then write that loss back over
 * the only copy of them there is. The variant machinery below is what carries them across, and
 * the reason `prependVariantEntry` copies *every* field rather than the ones a transcript happens
 * to show.
 *
 * It takes the repository as an argument rather than reaching for one: nothing here is the
 * harness's state, which is what let the whole cluster leave.
 */

import type {ConversationEntryProjection, ConversationStatus} from '../contracts/conversations.ts';
import {stripLeadingThinkingEndTag} from '../contracts/reasoning.ts';
import {type ConversationRepository, type SyncConversationEntry} from '../conversations/repository';
import {llamaRuntimeModelId} from '../models/compat';
import type {ChatMessage, ConfiguredModel} from '../lib/types';

export function syncPiConversation(
  conversations: ConversationRepository,
  conversationId: string,
  session: any,
  activeModel: ConfiguredModel,
  assistantMessage?: ChatMessage,
  status: ConversationStatus = 'running',
  metadata: {
    regeneratesPiEntryId?: string;
    displayGroupId?: string;
    userPromptText?: string;
    userAttachmentSummary?: unknown;
    seedEntries?: ConversationEntryProjection[];
  } = {},
): SyncConversationEntry[] {
  const branch = session.sessionManager.getBranch() as any[];
  const existingEntries = new Map([
    ...(metadata.seedEntries ?? []).map(entry => [entry.piEntryId, entry] as const),
    ...conversations
      .getConversationEntries(conversationId)
      .map(entry => [entry.piEntryId, entry] as const),
  ]);
  const entries: SyncConversationEntry[] = [];
  let lastAssistantEntryId: string | null = null;
  for (const entry of branch) {
    if (entry.type === 'compaction') {
      entries.push({
        piEntryId: String(entry.id),
        parentPiEntryId: entry.parentId ?? null,
        entryType: entry.type,
        text: String(entry.summary ?? 'Context compacted.'),
        createdAt: String(entry.timestamp ?? new Date().toISOString()),
        displayGroupId: String(entry.id),
      });
      continue;
    }
    if (entry.type !== 'message') {
      continue;
    }
    const role = normalizeChatRole(entry.message?.role);
    const rawText = extractMessageText(entry.message);
    // Pi stores what llama.cpp emitted, echoed budget end tag and all.
    const text = role === 'assistant' ? stripLeadingThinkingEndTag(rawText) : rawText;
    const projection: SyncConversationEntry = {
      piEntryId: String(entry.id),
      parentPiEntryId: entry.parentId ?? null,
      entryType: entry.type,
      role,
      text,
      createdAt: String(entry.timestamp ?? new Date().toISOString()),
      displayGroupId: String(entry.id),
    };
    const existingEntry = existingEntries.get(projection.piEntryId);
    projection.performance = existingEntry?.performance;
    projection.toolCalls = existingEntry?.toolCalls;
    projection.attachmentSummary = existingEntry?.attachmentSummary;
    projection.regeneratesPiEntryId = existingEntry?.regeneratesPiEntryId;
    projection.displayGroupId = existingEntry?.displayGroupId ?? projection.displayGroupId;
    projection.reasoning = extractMessageThinking(entry.message) || existingEntry?.reasoning;
    projection.text = displayedUserText(role, text, existingEntry?.textPreview);
    if (role === 'assistant') {
      projection.modelId = existingEntry?.modelId ?? activeModel.id;
      projection.modelRuntimeId = existingEntry?.modelRuntimeId ?? llamaRuntimeModelId(activeModel);
      projection.modelAliasSnapshot = existingEntry?.modelAliasSnapshot ?? activeModel.name;
      lastAssistantEntryId = projection.piEntryId;
    }
    entries.push(projection);
  }

  if (assistantMessage && lastAssistantEntryId) {
    const lastAssistant = entries.find(entry => entry.piEntryId === lastAssistantEntryId);
    if (lastAssistant) {
      lastAssistant.modelId = assistantMessage.modelId;
      lastAssistant.modelRuntimeId = assistantMessage.modelRuntimeId;
      lastAssistant.modelAliasSnapshot = assistantMessage.modelAliasSnapshot;
      lastAssistant.performance = assistantMessage.performance;
      lastAssistant.toolCalls = assistantMessage.toolCalls;
      lastAssistant.reasoning = lastAssistant.reasoning ?? assistantMessage.reasoning;
      lastAssistant.regeneratesPiEntryId = metadata.regeneratesPiEntryId;
      lastAssistant.displayGroupId = metadata.displayGroupId ?? metadata.regeneratesPiEntryId;
    }
    const promptedUser = findPromptUserEntry(entries, assistantMessage);
    if (promptedUser) {
      promptedUser.text = metadata.userPromptText ?? promptedUser.text;
      promptedUser.attachmentSummary =
        metadata.userAttachmentSummary ?? promptedUser.attachmentSummary;
    }
  }

  if (metadata.regeneratesPiEntryId) {
    prependExistingVariantGroup(
      entries,
      existingEntries,
      metadata.regeneratesPiEntryId,
      metadata.displayGroupId,
    );
  } else {
    // A sync with no metadata -- a snapshot refresh, a restart -- rebuilds the
    // projection from `getBranch()`, which only walks the active path. Without
    // this, the very next snapshot read after a regenerate drops the older
    // answer and its prompt: the prompt is hidden as a replayed user turn, and
    // the transcript shows a bare reply. The branch entries carry the group ids
    // back from the projection, so the groups can be rediscovered from them.
    for (const entry of [...entries]) {
      if (entry.role === 'assistant' && entry.regeneratesPiEntryId) {
        prependExistingVariantGroup(
          entries,
          existingEntries,
          entry.regeneratesPiEntryId,
          entry.displayGroupId ?? undefined,
        );
      }
    }
  }

  conversations.replaceConversationProjection(conversationId, {
    piSessionPath: session.sessionFile,
    piSessionId: session.sessionId,
    activeLeafPiEntryId: session.sessionManager.getLeafId(),
    lastSyncedPiEntryId: session.sessionManager.getLeafId(),
    status,
    entries,
  });
  return entries;
}

export function findPromptUserEntry(
  entries: SyncConversationEntry[],
  assistantMessage: ChatMessage,
): SyncConversationEntry | undefined {
  let assistantIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === 'assistant') {
      assistantIndex = index;
      if (!assistantMessage.content || entry.text === assistantMessage.content) {
        break;
      }
    }
  }
  if (assistantIndex < 0) {
    return undefined;
  }
  const assistantEntry = entries[assistantIndex];
  const parentId = assistantEntry?.parentPiEntryId;
  if (parentId) {
    const parent = entries.find(entry => entry.piEntryId === parentId);
    if (parent?.role === 'user') {
      return parent;
    }
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === 'user') {
      return entries[index];
    }
  }
  return undefined;
}

function prependVariantEntry(
  entries: SyncConversationEntry[],
  entry: SyncConversationEntry | ConversationEntryProjection,
): void {
  if (entries.some(item => item.piEntryId === entry.piEntryId)) {
    return;
  }
  entries.unshift({
    piEntryId: entry.piEntryId,
    parentPiEntryId: entry.parentPiEntryId ?? null,
    entryType: entry.entryType,
    role: entry.role ?? null,
    text: isProjectionEntry(entry) ? (entry.textPreview ?? '') : entry.text,
    createdAt: entry.createdAt,
    modelId: entry.modelId,
    modelRuntimeId: entry.modelRuntimeId,
    modelAliasSnapshot: entry.modelAliasSnapshot,
    performance: entry.performance,
    toolCalls: entry.toolCalls,
    attachmentSummary: entry.attachmentSummary,
    // A variant is off the active branch, so `getBranch()` never sees it again and this
    // row is the only copy left. Dropping its reasoning here -- as this did -- means
    // regenerating an answer silently destroys the thinking of the answer it branched
    // from, and a projection rebuild writes the loss back over the row.
    reasoning: entry.reasoning,
    regeneratesPiEntryId: entry.regeneratesPiEntryId ?? null,
    displayGroupId: entry.displayGroupId ?? entry.piEntryId,
  });
}

/**
 * Carries the answers a regenerate branched away from back into the projection.
 *
 * Exported for tests: a variant is off the active branch, so `getBranch()` will never
 * hand it back and the projection row is the last copy of it there is.
 */
/**
 * The text a turn should *display*, given what Pi holds and what the projection already
 * held.
 *
 * Pi's copy of a **user** turn is the *enriched* prompt: the typed text plus the
 * attachment payload the model was actually shown — `<attachment name="secret.txt">` with
 * the whole file inside it. The typed text exists only in the projection, where the run
 * put it (`metadata.userPromptText`), and it cannot be recovered from Pi afterwards.
 *
 * A metadata-less sync — every snapshot read, every restart — rebuilds from `getBranch()`
 * and would otherwise overwrite the typed text with Pi's copy, so the transcript would
 * show the user the contents of their own attachment pasted into their message. The
 * projection wins for user turns, and only for user turns: an assistant's text is Pi's.
 */
export function displayedUserText(
  role: string | null | undefined,
  piText: string,
  projectedText: string | undefined,
): string {
  return role === 'user' && projectedText != null ? projectedText : piText;
}

export function prependExistingVariantGroup(
  entries: SyncConversationEntry[],
  existingEntries: Map<string, ConversationEntryProjection>,
  regeneratesPiEntryId?: string,
  displayGroupId?: string,
): void {
  if (!regeneratesPiEntryId) {
    return;
  }
  const sourceAssistant = existingEntries.get(regeneratesPiEntryId);
  const groupId = displayGroupId ?? sourceAssistant?.displayGroupId ?? regeneratesPiEntryId;
  const variantAssistants = [...existingEntries.values()]
    .filter(
      entry =>
        entry.role === 'assistant' && belongsToVariantGroup(entry, regeneratesPiEntryId, groupId),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const groupEntries: ConversationEntryProjection[] = [];
  const seen = new Set<string>();
  for (const assistant of variantAssistants) {
    const parent = assistant.parentPiEntryId
      ? existingEntries.get(assistant.parentPiEntryId)
      : undefined;
    if (parent && !seen.has(parent.piEntryId)) {
      groupEntries.push(parent);
      seen.add(parent.piEntryId);
    }
    if (!seen.has(assistant.piEntryId)) {
      groupEntries.push(assistant);
      seen.add(assistant.piEntryId);
    }
  }
  for (let index = groupEntries.length - 1; index >= 0; index -= 1) {
    prependVariantEntry(entries, groupEntries[index]!);
  }
}

function belongsToVariantGroup(
  entry: ConversationEntryProjection,
  regeneratesPiEntryId: string,
  displayGroupId: string,
): boolean {
  return (
    entry.piEntryId === regeneratesPiEntryId ||
    entry.displayGroupId === displayGroupId ||
    entry.regeneratesPiEntryId === regeneratesPiEntryId ||
    entry.regeneratesPiEntryId === displayGroupId
  );
}

function isProjectionEntry(
  entry: SyncConversationEntry | ConversationEntryProjection,
): entry is ConversationEntryProjection {
  return 'textPreview' in entry;
}

function normalizeChatRole(role: unknown): ChatMessage['role'] | undefined {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }
  return undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as {content?: unknown}).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(item => {
      if (typeof item === 'string') {
        return item;
      }
      if (!item || typeof item !== 'object') {
        return '';
      }
      const type = (item as {type?: unknown}).type;
      if (type === 'text' && typeof (item as {text?: unknown}).text === 'string') {
        return (item as {text: string}).text;
      }
      if (type === 'toolCall' && typeof (item as {name?: unknown}).name === 'string') {
        return `[tool call: ${(item as {name: string}).name}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Pi stores llama.cpp's `reasoning_content` as `{type: 'thinking', thinking}`
 * content blocks alongside the answer text, so the session file stays the
 * source of truth for a conversation's thinking history.
 */
function extractMessageThinking(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as {content?: unknown}).content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(item => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const block = item as {type?: unknown; thinking?: unknown; redacted?: unknown};
      if (block.type !== 'thinking' || block.redacted === true) {
        return '';
      }
      return typeof block.thinking === 'string' ? block.thinking : '';
    })
    .filter(Boolean)
    .join('\n');
}
