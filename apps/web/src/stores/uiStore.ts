import {create} from 'zustand';

import type {SettingsSection} from '../types';

type UiStore = {
  isSidebarCollapsed: boolean;
  isSettingsOpen: boolean;
  settingsSection: SettingsSection;
  conversationSearch: string;
  setSidebarCollapsed: (isCollapsed: boolean) => void;
  setSettingsOpen: (isOpen: boolean) => void;
  setSettingsSection: (section: SettingsSection) => void;
  setConversationSearch: (query: string) => void;
  toggleSettings: () => void;
};

export const useUiStore = create<UiStore>(set => ({
  isSidebarCollapsed: false,
  isSettingsOpen: false,
  settingsSection: 'runtime',
  conversationSearch: '',
  setSidebarCollapsed: isCollapsed => set({isSidebarCollapsed: isCollapsed}),
  setSettingsOpen: isOpen => set({isSettingsOpen: isOpen}),
  setSettingsSection: section => set({settingsSection: section}),
  setConversationSearch: query => set({conversationSearch: query}),
  toggleSettings: () => set(state => ({isSettingsOpen: !state.isSettingsOpen})),
}));
