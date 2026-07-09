import {z} from 'zod';

import type {AttachmentMetadata} from './attachmentMetadata.ts';
import {attachmentMetadataSchema} from './attachmentMetadata.ts';
// Type-only: erased at runtime, so `conversations.ts` may import this module.
import type {ConversationEntryProjection} from './conversations.ts';

/**
 * A renderable chat message.
 *
 * This is what a client draws. It is derived from the entry projection, but the
 * derivation is not obvious: it hides user turns a regenerate replayed, drops
 * assistant entries Pi wrote for a failed turn, and groups regenerated answers
 * into labelled variants. Those rules lived in the browser, which meant every
 * future client had to reimplement them identically or render ghosts.
 */
export const conversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  createdAt: z.string(),
  parentPiEntryId: z.string().optional(),
  modelId: z.string().optional(),
  modelRuntimeId: z.string().optional(),
  modelAliasSnapshot: z.string().optional(),
  regeneratesPiEntryId: z.string().optional(),
  displayGroupId: z.string().optional(),
  /** `variant 2/3` when a prompt has more than one answer. */
  variantLabel: z.string().optional(),
  performance: z.unknown().optional(),
  toolCalls: z.unknown().optional(),
  reasoning: z.string().optional(),
  attachments: z.array(attachmentMetadataSchema).optional(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/**
 * Projects entries plus attachments into the messages a client renders.
 *
 * Pure: same inputs, same output, no clock and no I/O. It runs on the server so
 * the snapshot is self-describing, and lives here so the server and any
 * TypeScript client share one copy.
 */
export function buildConversationMessages(
  entries: ConversationEntryProjection[],
  attachments: AttachmentMetadata[],
): ConversationMessage[] {
  const attachmentsByEntry = new Map<string, AttachmentMetadata[]>();
  for (const attachment of attachments) {
    if (!attachment.piEntryId) {
      continue;
    }
    const list = attachmentsByEntry.get(attachment.piEntryId) ?? [];
    list.push(attachment);
    attachmentsByEntry.set(attachment.piEntryId, list);
  }

  const messages: ConversationMessage[] = entries
    .filter(entry => entry.entryType === 'message' && entry.role != null)
    .map(entry => ({
      id: entry.piEntryId,
      role: entry.role!,
      content: entry.textPreview ?? '',
      createdAt: entry.createdAt,
      parentPiEntryId: entry.parentPiEntryId,
      modelId: entry.modelId,
      modelRuntimeId: entry.modelRuntimeId,
      modelAliasSnapshot: entry.modelAliasSnapshot,
      regeneratesPiEntryId: entry.regeneratesPiEntryId,
      displayGroupId: entry.displayGroupId,
      performance: entry.performance,
      toolCalls: entry.toolCalls,
      reasoning: entry.reasoning,
      attachments: attachmentsByEntry.get(entry.piEntryId),
    }));

  // Regeneration replays the original user text on a new Pi branch, so the same
  // prompt appears twice. Show it once.
  const replayedUserIds = new Set(
    messages
      .filter(message => message.role === 'assistant' && message.regeneratesPiEntryId)
      .map(message => message.parentPiEntryId)
      .filter(id => id != null),
  );

  const visibleMessages = messages.filter(message => {
    if (message.role === 'user' && replayedUserIds.has(message.id)) {
      return false;
    }
    // Pi persists a failed turn as an assistant entry with no content -- for
    // example when llama.cpp answers 500 while a model is still loading -- and
    // then retries. Rendering it produced a ghost bubble above the real answer.
    // A contentless assistant turn with nothing to show is dropped; one that
    // exhausted its reasoning budget still has its thinking block.
    if (
      message.role === 'assistant' &&
      !message.content.trim() &&
      !toolCallCount(message.toolCalls) &&
      !message.reasoning?.trim()
    ) {
      return false;
    }
    return true;
  });

  labelAssistantVariants(visibleMessages);
  return visibleMessages;
}

/** Answers for one prompt are variants of each other, and say so. */
function labelAssistantVariants(messages: ConversationMessage[]): void {
  const groups = new Map<string, ConversationMessage[]>();
  for (const message of messages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const groupId = message.displayGroupId ?? message.regeneratesPiEntryId ?? message.id;
    const group = groups.get(groupId) ?? [];
    group.push(message);
    groups.set(groupId, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    group
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .forEach((message, index) => {
        message.variantLabel = `variant ${index + 1}/${group.length}`;
      });
  }
}

function toolCallCount(toolCalls: unknown): number {
  return Array.isArray(toolCalls) ? toolCalls.length : 0;
}
