import {create} from 'zustand';

import type {ConfiguredModel, HuggingFaceModelResult} from '../api';
import type {ParamRow} from '../types';
import {paramsToRows} from '../utils/params';

type SettingsStore = {
  globalParamRows: ParamRow[];
  isLogVisible: boolean;
  isSearching: boolean;
  modelAliasDrafts: Record<string, string>;
  modelParamRows: Record<string, ParamRow[]>;
  modelsMaxInput: string;
  runtimeLogs: string;
  searchQuery: string;
  searchResults: HuggingFaceModelResult[];
  sleepIdleInput: string;
  setGlobalParamRows: (rows: ParamRow[]) => void;
  setIsLogVisible: (isVisible: boolean) => void;
  setIsSearching: (isSearching: boolean) => void;
  setModelAliasDraft: (modelId: string, value: string) => void;
  setModelParamRows: (modelId: string, rows: ParamRow[]) => void;
  setModelsMaxInput: (value: string) => void;
  setRuntimeLogs: (logs: string) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: HuggingFaceModelResult[]) => void;
  setSleepIdleInput: (value: string) => void;
  syncModelDrafts: (
    globalParams: Record<string, string> | undefined,
    models: ConfiguredModel[],
  ) => void;
  syncRuntimeDrafts: (modelsMax: number | undefined, sleepIdleSeconds: number | undefined) => void;
};

export const useSettingsStore = create<SettingsStore>(set => ({
  globalParamRows: paramsToRows({c: '8192'}),
  isLogVisible: false,
  isSearching: false,
  modelAliasDrafts: {},
  modelParamRows: {},
  modelsMaxInput: '1',
  runtimeLogs: '',
  searchQuery: 'qwen gguf',
  searchResults: [],
  sleepIdleInput: '90',
  setGlobalParamRows: rows => set({globalParamRows: rows}),
  setIsLogVisible: isVisible => set({isLogVisible: isVisible}),
  setIsSearching: isSearching => set({isSearching}),
  setModelAliasDraft: (modelId, value) =>
    set(state => ({
      modelAliasDrafts: {...state.modelAliasDrafts, [modelId]: value},
    })),
  setModelParamRows: (modelId, rows) =>
    set(state => ({
      modelParamRows: {...state.modelParamRows, [modelId]: rows},
    })),
  setModelsMaxInput: value => set({modelsMaxInput: value}),
  setRuntimeLogs: logs => set({runtimeLogs: logs}),
  setSearchQuery: query => set({searchQuery: query}),
  setSearchResults: results => set({searchResults: results}),
  setSleepIdleInput: value => set({sleepIdleInput: value}),
  syncModelDrafts: (globalParams, models) =>
    set({
      globalParamRows: paramsToRows(globalParams ?? {c: '8192'}),
      modelAliasDrafts: Object.fromEntries(models.map(model => [model.id, model.name])),
      modelParamRows: Object.fromEntries(
        models.map(model => [model.id, paramsToRows(model.params.extra ?? {})]),
      ),
    }),
  syncRuntimeDrafts: (modelsMax, sleepIdleSeconds) =>
    set({
      modelsMaxInput: String(modelsMax ?? 1),
      sleepIdleInput: String(sleepIdleSeconds ?? 90),
    }),
}));
