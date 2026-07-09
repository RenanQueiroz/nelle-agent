import {create} from 'zustand';

import type {DraftAttachment} from '../types';

/**
 * Composer-local state. Keeping the draft here (instead of in `App`) means a
 * keystroke only re-renders the composer, not the chat transcript.
 */
type ComposerStore = {
  draft: string;
  attachments: DraftAttachment[];
  isPdfImageModeEnabled: boolean;
  slashCommandError: string | null;
  error: string | null;
  warning: string | null;
  setDraft: (value: string) => void;
  setAttachments: (attachments: DraftAttachment[]) => void;
  addAttachments: (attachments: DraftAttachment[]) => void;
  removeAttachment: (id: string) => void;
  setPdfImageModeEnabled: (isEnabled: boolean) => void;
  setSlashCommandError: (message: string | null) => void;
  setError: (message: string | null) => void;
  setWarning: (message: string | null) => void;
  clearStatus: () => void;
  resetDraft: () => void;
};

export const useComposerStore = create<ComposerStore>(set => ({
  draft: '',
  attachments: [],
  isPdfImageModeEnabled: false,
  slashCommandError: null,
  error: null,
  warning: null,
  setDraft: value => set({draft: value}),
  setAttachments: attachments => set({attachments}),
  addAttachments: attachments =>
    set(state => ({attachments: [...state.attachments, ...attachments]})),
  removeAttachment: id =>
    set(state => ({attachments: state.attachments.filter(item => item.id !== id)})),
  setPdfImageModeEnabled: isEnabled => set({isPdfImageModeEnabled: isEnabled}),
  setSlashCommandError: message => set({slashCommandError: message}),
  setError: message => set({error: message}),
  setWarning: message => set({warning: message}),
  clearStatus: () => set({slashCommandError: null, error: null, warning: null}),
  resetDraft: () => set({attachments: [], slashCommandError: null, error: null, warning: null}),
}));

/**
 * ChatComposer clears its value right after `onSubmit`, so a rejected send has
 * to put the draft back on the next tick.
 */
export function restoreComposerDraft(value: string): void {
  window.setTimeout(() => {
    useComposerStore.getState().setDraft(value);
  }, 0);
}
