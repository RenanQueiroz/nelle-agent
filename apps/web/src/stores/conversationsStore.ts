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
  setStatus: (conversationId: string, status: ConversationListItem['status']) => void;
  setGeneratedTitle: (conversationId: string, title: string) => void;
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

    loadFirstPage: async search => {
      const request = (latestRequest += 1);
      const page = await getConversations({search: search || undefined, limit: PAGE_SIZE});
      if (request !== latestRequest) {
        return get().conversations;
      }
      set({
        conversations: page.conversations,
        nextCursor: page.nextCursor,
        total: page.total,
        loadedSearch: search,
        isLoadingMore: false,
        hasLoaded: true,
      });
      return page.conversations;
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
          const seen = new Set(state.conversations.map(conversation => conversation.id));
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

    setGeneratedTitle: (conversationId, title) =>
      set(state => ({
        conversations: state.conversations.map(conversation =>
          conversation.id === conversationId
            ? {...conversation, title, titleSource: 'generated'}
            : conversation,
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
      });
    },
  };
});
