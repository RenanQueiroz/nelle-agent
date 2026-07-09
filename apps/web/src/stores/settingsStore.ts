import {create} from 'zustand';

import type {ConfiguredModel, HuggingFaceModelResult, ReasoningBudgets} from '../api';
import {DEFAULT_REASONING_BUDGETS} from '../api';
import type {ParamRow} from '../types';
import {paramsToRows} from '../utils/params';

/**
 * Settings drafts are what the user is currently typing, so nothing may
 * overwrite them except the save that made them stale. `seed*` runs once on
 * load; `reset*` runs after the matching save, from the values the server
 * returned; `reconcileModelDrafts` only adds and removes whole models.
 */
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
  seedModelDrafts: (
    globalParams: Record<string, string> | undefined,
    models: ConfiguredModel[],
  ) => void;
  /** Adds drafts for new models and drops them for removed ones. */
  reconcileModelDrafts: (models: ConfiguredModel[]) => void;
  resetGlobalParamRows: (globalParams: Record<string, string> | undefined) => void;
  resetModelDraft: (model: ConfiguredModel) => void;
  resetReasoningDrafts: (budgets: ReasoningBudgets | undefined) => void;
  resetRuntimeDrafts: (modelsMax: number | undefined, sleepIdleSeconds: number | undefined) => void;
};

function budgetInputs(budgets: ReasoningBudgets): Record<keyof ReasoningBudgets, string> {
  return {
    low: String(budgets.low),
    medium: String(budgets.medium),
    high: String(budgets.high),
  };
}

const DEFAULT_GLOBAL_PARAMS = {c: '8192'};

export const useSettingsStore = create<SettingsStore>(set => ({
  globalParamRows: paramsToRows(DEFAULT_GLOBAL_PARAMS),
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
  seedModelDrafts: (globalParams, models) =>
    set({
      globalParamRows: paramsToRows(globalParams ?? DEFAULT_GLOBAL_PARAMS),
      modelAliasDrafts: Object.fromEntries(models.map(model => [model.id, model.name])),
      modelParamRows: Object.fromEntries(
        models.map(model => [model.id, paramsToRows(model.params.extra ?? {})]),
      ),
    }),
  reconcileModelDrafts: models =>
    set(state => {
      const modelAliasDrafts: Record<string, string> = {};
      const modelParamRows: Record<string, ParamRow[]> = {};
      for (const model of models) {
        modelAliasDrafts[model.id] = state.modelAliasDrafts[model.id] ?? model.name;
        modelParamRows[model.id] =
          state.modelParamRows[model.id] ?? paramsToRows(model.params.extra ?? {});
      }
      return {modelAliasDrafts, modelParamRows};
    }),
  resetGlobalParamRows: globalParams =>
    set({globalParamRows: paramsToRows(globalParams ?? DEFAULT_GLOBAL_PARAMS)}),
  resetModelDraft: model =>
    set(state => ({
      modelAliasDrafts: {...state.modelAliasDrafts, [model.id]: model.name},
      modelParamRows: {
        ...state.modelParamRows,
        [model.id]: paramsToRows(model.params.extra ?? {}),
      },
    })),
  resetReasoningDrafts: budgets =>
    set({reasoningBudgetInputs: budgetInputs(budgets ?? DEFAULT_REASONING_BUDGETS)}),
  resetRuntimeDrafts: (modelsMax, sleepIdleSeconds) =>
    set({
      modelsMaxInput: String(modelsMax ?? 1),
      sleepIdleInput: String(sleepIdleSeconds ?? 90),
    }),
}));
