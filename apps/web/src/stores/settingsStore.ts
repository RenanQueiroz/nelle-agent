import {create} from 'zustand';

import type {ConfiguredModel, HuggingFaceModelResult, ReasoningBudgets} from '../api';
import {DEFAULT_REASONING_BUDGETS} from '../api';
import type {ParamRow} from '../types';
import {paramsToRows} from '../utils/params';

type SettingsStore = {
  globalParamRows: ParamRow[];
  isLogVisible: boolean;
  isSearching: boolean;
  modelAliasDrafts: Record<string, string>;
  modelParamRows: Record<string, ParamRow[]>;
  modelsMaxInput: string;
  reasoningBudgetInputs: Record<keyof ReasoningBudgets, string>;
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
  setReasoningBudgetInput: (level: keyof ReasoningBudgets, value: string) => void;
  setRuntimeLogs: (logs: string) => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: HuggingFaceModelResult[]) => void;
  setSleepIdleInput: (value: string) => void;
  syncModelDrafts: (
    globalParams: Record<string, string> | undefined,
    models: ConfiguredModel[],
  ) => void;
  syncReasoningDrafts: (budgets: ReasoningBudgets | undefined) => void;
  syncRuntimeDrafts: (modelsMax: number | undefined, sleepIdleSeconds: number | undefined) => void;
};

function budgetInputs(budgets: ReasoningBudgets): Record<keyof ReasoningBudgets, string> {
  return {
    low: String(budgets.low),
    medium: String(budgets.medium),
    high: String(budgets.high),
  };
}

export const useSettingsStore = create<SettingsStore>(set => ({
  globalParamRows: paramsToRows({c: '8192'}),
  isLogVisible: false,
  isSearching: false,
  modelAliasDrafts: {},
  modelParamRows: {},
  modelsMaxInput: '1',
  reasoningBudgetInputs: budgetInputs(DEFAULT_REASONING_BUDGETS),
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
  setReasoningBudgetInput: (level, value) =>
    set(state => ({
      reasoningBudgetInputs: {...state.reasoningBudgetInputs, [level]: value},
    })),
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
  syncReasoningDrafts: budgets =>
    set({reasoningBudgetInputs: budgetInputs(budgets ?? DEFAULT_REASONING_BUDGETS)}),
  syncRuntimeDrafts: (modelsMax, sleepIdleSeconds) =>
    set({
      modelsMaxInput: String(modelsMax ?? 1),
      sleepIdleInput: String(sleepIdleSeconds ?? 90),
    }),
}));
