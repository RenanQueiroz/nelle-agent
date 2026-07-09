import {create} from 'zustand';

import type {ConversationListItem} from '../api';
import {getConversations} from '../api';

const PAGE_SIZE = 50;

type ConversationsStore = {
  conversations: ConversationListItem[];
  nextCursor?: string;
  /** Every conversation matching the search, not only the loaded ones. */
  total: number;
  /** The search whose results are currently in `conversations`. */
  loadedSearch: string;
  isLoadingMore: boolean;
  hasLoaded: boolean;
  /** Replaces the list. Returns the loaded page so callers can pick an active row. */
  loadFirstPage: (search: string) => Promise<ConversationListItem[]>;
  loadNextPage: () => Promise<void>;
  /** Ids withheld from the sidebar while their delete waits out the undo window. */
  hiddenIds: string[];
  hideConversation: (conversationId: string) => void;
  unhideConversation: (conversationId: string) => void;
  setStatus: (conversationId: string, status: ConversationListItem['status']) => void;
  setConversationTitle: (
    conversationId: string,
    title: string,
    titleSource: ConversationListItem['titleSource'],
  ) => void;
  clear: () => void;
};

/**
 * The sidebar's window onto the server's conversation list.
 *
 * Lives outside `App.tsx` so paging and search keystrokes redraw the sidebar
 * without redrawing the chat transcript.
 */
export const useConversationsStore = create<ConversationsStore>((set, get) => {
  // A fast typist leaves several first-page requests in flight. Only the newest
  // may write, or a slow response for "ne" lands after "nelle" and the list
  // stops matching the search box.
  let latestRequest = 0;

  return {
    conversations: [],
    nextCursor: undefined,
    total: 0,
    loadedSearch: '',
    isLoadingMore: false,
    hasLoaded: false,
    hiddenIds: [],

    hideConversation: conversationId =>
      set(state => ({
        hiddenIds: state.hiddenIds.includes(conversationId)
          ? state.hiddenIds
          : [...state.hiddenIds, conversationId],
        conversations: state.conversations.filter(
          conversation => conversation.id !== conversationId,
        ),
        total: Math.max(0, state.total - 1),
      })),

    unhideConversation: conversationId =>
      set(state => ({
        hiddenIds: state.hiddenIds.filter(id => id !== conversationId),
      })),

    loadFirstPage: async search => {
      const request = (latestRequest += 1);
      const page = await getConversations({search: search || undefined, limit: PAGE_SIZE});
      if (request !== latestRequest) {
        return get().conversations;
      }
      // The server still knows about a conversation whose delete is waiting out
      // the undo window. Keep it out of the sidebar, or it reappears on the next
      // refresh, which reads as the delete having failed.
      const hidden = new Set(get().hiddenIds);
      const conversations = page.conversations.filter(conversation => !hidden.has(conversation.id));
      set({
        conversations,
        nextCursor: page.nextCursor,
        total: Math.max(0, page.total - hidden.size),
        loadedSearch: search,
        isLoadingMore: false,
        hasLoaded: true,
      });
      return conversations;
    },

    loadNextPage: async () => {
      const {nextCursor, isLoadingMore, loadedSearch} = get();
      if (!nextCursor || isLoadingMore) {
        return;
      }
      const request = latestRequest;
      set({isLoadingMore: true});
      try {
        const page = await getConversations({
          search: loadedSearch || undefined,
          cursor: nextCursor,
          limit: PAGE_SIZE,
        });
        // A first-page load started while this page was in flight, so the list
        // it belonged to is gone. Appending would splice rows from the old
        // search into the new one.
        if (request !== latestRequest) {
          return;
        }
        set(state => {
          const seen = new Set([
            ...state.conversations.map(conversation => conversation.id),
            ...state.hiddenIds,
          ]);
          // A conversation answered mid-scroll moves up the ordering and can
          // surface on two pages. Keep the copy already rendered.
          const fresh = page.conversations.filter(conversation => !seen.has(conversation.id));
          return {
            conversations: [...state.conversations, ...fresh],
            nextCursor: page.nextCursor,
            total: page.total,
          };
        });
      } finally {
        if (request === latestRequest) {
          set({isLoadingMore: false});
        }
      }
    },

    setStatus: (conversationId, status) =>
      set(state => ({
        conversations: state.conversations.map(conversation =>
          conversation.id === conversationId
            ? {...conversation, status, updatedAt: new Date().toISOString()}
            : conversation,
        ),
      })),

    setConversationTitle: (conversationId, title, titleSource) =>
      set(state => ({
        conversations: state.conversations.map(conversation =>
          conversation.id === conversationId ? {...conversation, title, titleSource} : conversation,
        ),
      })),

    clear: () => {
      latestRequest += 1;
      set({
        conversations: [],
        nextCursor: undefined,
        total: 0,
        loadedSearch: '',
        isLoadingMore: false,
        hasLoaded: false,
        hiddenIds: [],
      });
    },
  };
});
