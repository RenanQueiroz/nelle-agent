import {create} from 'zustand';

import {updatePreferences} from '../api';
import type {Preferences} from '../api';
import {
  DEFAULT_DISPLAY_PREFERENCES,
  type DisplayPreferences,
} from '../../../../packages/shared/src/displayPreferences.ts';

/**
 * The display toggles, applied by the client and stored on the server.
 *
 * They start at Nelle's own defaults rather than at nothing, because a
 * transcript has to render before `GET /api/settings/preferences` answers, and
 * the defaults are exactly what Nelle did before these existed. Saving is
 * optimistic: the toggle flips at once and the server is told, because a
 * rendering preference is not worth a spinner.
 */
type PreferencesStore = DisplayPreferences & {
  seed: (preferences: Preferences) => void;
  toggle: (key: keyof DisplayPreferences, value: boolean) => Promise<void>;
};

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  ...DEFAULT_DISPLAY_PREFERENCES,
  seed: preferences =>
    set({
      showGenerationStats: preferences.showGenerationStats,
      showThinkingInProgress: preferences.showThinkingInProgress,
      showToolCallsInProgress: preferences.showToolCallsInProgress,
      renderUserContentAsMarkdown: preferences.renderUserContentAsMarkdown,
      renderThinkingAsMarkdown: preferences.renderThinkingAsMarkdown,
      disableAutoScroll: preferences.disableAutoScroll,
    }),
  toggle: async (key, value) => {
    const previous = get()[key];
    set({[key]: value} as Partial<DisplayPreferences>);
    try {
      await updatePreferences({[key]: value});
    } catch {
      // The server refused or is unreachable. Put the switch back rather than
      // leave the user looking at a preference that was never saved.
      set({[key]: previous} as Partial<DisplayPreferences>);
    }
  },
}));
