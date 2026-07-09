/** How long the user has to take a conversation delete back. */
export const DELETE_UNDO_WINDOW_MS = 5_000;

type PendingDelete = {
  timer: number;
  commit: () => void;
};

const pending = new Map<string, PendingDelete>();

/**
 * Holds a conversation delete for the undo window, then commits it.
 *
 * Deferring the request is the only way to offer undo without soft delete, which
 * Nelle deliberately does not have. The cost is that the deletion has not
 * happened yet while the window is open, so it has to be committed on unload
 * (see `flushPendingDeletes`) rather than silently dropped.
 */
export function schedulePendingDelete(conversationId: string, commit: () => void): void {
  cancelPendingDelete(conversationId);
  const timer = window.setTimeout(() => {
    pending.delete(conversationId);
    commit();
  }, DELETE_UNDO_WINDOW_MS);
  pending.set(conversationId, {timer, commit});
}

/** Returns true when there was something to cancel. */
export function cancelPendingDelete(conversationId: string): boolean {
  const entry = pending.get(conversationId);
  if (!entry) {
    return false;
  }
  window.clearTimeout(entry.timer);
  pending.delete(conversationId);
  return true;
}

export function hasPendingDelete(conversationId: string): boolean {
  return pending.has(conversationId);
}

/**
 * Commits every held delete before the page goes away.
 *
 * Without this, closing the tab or reloading inside the undo window would
 * silently cancel the deletion, and the conversation would come back from the
 * dead on the next load. `keepalive` is what lets the request outlive the page;
 * `sendBeacon` cannot be used because it only issues POSTs.
 */
export function flushPendingDeletes(): void {
  for (const [conversationId, entry] of pending) {
    window.clearTimeout(entry.timer);
    void fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => {
      // The page is unloading; there is nobody left to tell.
    });
  }
  pending.clear();
}

let isUnloadHandlerRegistered = false;

export function registerPendingDeleteFlush(): void {
  if (isUnloadHandlerRegistered || typeof window === 'undefined') {
    return;
  }
  isUnloadHandlerRegistered = true;
  // `pagehide` fires for reloads, navigations and bfcache evictions, where
  // `beforeunload` is unreliable on mobile Safari.
  window.addEventListener('pagehide', flushPendingDeletes);
}
