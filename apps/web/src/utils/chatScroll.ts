import {useEffect, type RefObject} from 'react';

import {usePreferencesStore} from '../stores/preferencesStore';

/**
 * Astryx's `useChatStreamScroll` jumps to the bottom exactly once, inside a
 * single `requestAnimationFrame` on mount. Nelle keeps one `ChatLayout`
 * mounted across conversation switches, and the transcript arrives from an
 * async snapshot fetch, so that jump either never re-runs or measures a
 * `scrollHeight` that markdown, fonts, and images have not finished growing
 * yet.
 *
 * This pins the transcript to the bottom after a conversation is opened,
 * re-measuring every frame and re-arming whenever the content grows. It holds
 * for at least `MIN_PIN_MS` because the transcript is still empty while the
 * snapshot is in flight, then stops once the height has been quiet for
 * `QUIET_MS`, once `MAX_PIN_MS` elapses, or as soon as the reader takes
 * control.
 */
const MIN_PIN_MS = 1200;
const QUIET_MS = 250;
const MAX_PIN_MS = 5000;

export function useScrollChatToBottomOnOpen(
  scrollRef: RefObject<HTMLElement | null>,
  conversationId: string,
): void {
  const disableAutoScroll = usePreferencesStore(state => state.disableAutoScroll);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !conversationId || disableAutoScroll) {
      return;
    }

    let cancelled = false;
    let frame = 0;

    const release = () => {
      cancelled = true;
    };
    const releaseOnScrollUp = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        release();
      }
    };

    element.addEventListener('wheel', releaseOnScrollUp, {passive: true});
    element.addEventListener('touchmove', release, {passive: true});
    element.addEventListener('pointerdown', release, {passive: true});

    const startedAt = performance.now();
    let quietUntil = startedAt + MIN_PIN_MS;
    let lastScrollHeight = -1;

    const pin = () => {
      if (cancelled || !element.isConnected) {
        return;
      }
      // Assigning past the maximum lets the browser clamp exactly, which
      // avoids the rounding drift of `scrollHeight - clientHeight`.
      element.scrollTop = element.scrollHeight;

      const now = performance.now();
      if (element.scrollHeight !== lastScrollHeight) {
        lastScrollHeight = element.scrollHeight;
        quietUntil = Math.max(quietUntil, now + QUIET_MS);
      }
      if (now >= quietUntil || now - startedAt >= MAX_PIN_MS) {
        return;
      }
      frame = requestAnimationFrame(pin);
    };

    frame = requestAnimationFrame(pin);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      element.removeEventListener('wheel', releaseOnScrollUp);
      element.removeEventListener('touchmove', release);
      element.removeEventListener('pointerdown', release);
    };
  }, [scrollRef, conversationId, disableAutoScroll]);
}
