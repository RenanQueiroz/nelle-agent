import type {ConversationListItem} from '../api';

export type ConversationSectionId = 'pinned' | 'recent' | 'results';

export type ConversationListRow =
  | {
      key: string;
      type: 'section';
      id: ConversationSectionId;
      label: string;
      count: number;
    }
  | {
      key: string;
      type: 'conversation';
      conversation: ConversationListItem;
    };

/**
 * Flattens the loaded page into pinned and recent sections.
 *
 * `query` only picks the section label. The server did the filtering; the rows
 * handed in are already the matches. `total` counts every match, including the
 * ones not paged in yet, so the section header does not report the size of the
 * scroll window as the size of the list.
 */
export function buildConversationRows(
  conversations: ConversationListItem[],
  query: string,
  total: number,
): ConversationListRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const pinned = conversations.filter(conversation => conversation.pinned);
  const unpinned = conversations.filter(conversation => !conversation.pinned);
  // Every pinned row arrives on the first page, so the remainder is unpinned.
  const unpinnedTotal = Math.max(total - pinned.length, unpinned.length);
  const rows: ConversationListRow[] = [];
  if (pinned.length > 0) {
    rows.push({
      key: 'section:pinned',
      type: 'section',
      id: 'pinned',
      label: 'Pinned',
      count: pinned.length,
    });
    for (const conversation of pinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  if (unpinned.length > 0) {
    rows.push({
      key: normalizedQuery ? 'section:results' : 'section:recent',
      type: 'section',
      id: normalizedQuery ? 'results' : 'recent',
      label: normalizedQuery ? 'Results' : 'Recent',
      count: unpinnedTotal,
    });
    for (const conversation of unpinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  return rows;
}
