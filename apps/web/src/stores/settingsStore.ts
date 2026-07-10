import {create} from 'zustand';

import type {
  ConfiguredModel,
  HuggingFaceModelResult,
  InvalidModelParam,
  ReasoningBudgets,
  SettingsGroupSchema,
  SettingsValue,
  SettingsValues,
} from '../api';
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

  /** The server's field list. Empty until `GET /api/settings/schema` answers. */
  settingsSchema: SettingsGroupSchema[];
  /** What the user is typing, per group slug. Empty until the values arrive. */
  settingsDrafts: Record<string, SettingsValues>;
  /**
   * What the server last said is saved, per group slug. A setting the app *acts*
   * on reads this, never the draft: a half-typed threshold is not in force until
   * it is saved.
   */
  settingsValues: Record<string, SettingsValues>;
  settingsError: string | null;
  seedSettings: (schema: SettingsGroupSchema[], values: Record<string, SettingsValues>) => void;
  setSettingsField: (slug: string, key: string, value: SettingsValue) => void;
  setSettingsError: (message: string | null) => void;
  /** After the save that made the draft stale, from the values the server returned. */
  resetSettingsDraft: (slug: string, values: SettingsValues) => void;

  /**
   * Which `models.ini` keys the server refused, per editor: `'global'` for the
   * `[*]` section, otherwise a model id.
   *
   * Keyed by the offending key, never by row id, so a row stops being marked the
   * moment its key changes and no other row is disturbed. Editing a row does not
   * clear the whole scope: doing that would unmark a genuinely bad key because
   * the user touched a different one.
   */
  paramErrors: Record<string, InvalidModelParam[]>;
  setParamErrors: (scope: string, invalid: InvalidModelParam[]) => void;
};

export const GLOBAL_PARAM_SCOPE = 'global';

function budgetInputs(budgets: ReasoningBudgets): Record<keyof ReasoningBudgets, string> {
  return {
    low: String(budgets.low),
    medium: String(budgets.medium),
    high: String(budgets.high),
  };
}

/**
 * Drafts start empty, not at invented defaults.
 *
 * The store used to seed `{c: '8192'}`, `modelsMax: '1'` and `sleepIdle: '90'` --
 * a second copy of policy the server owns, and 8192 is the exact context size
 * AGENTS.md documents as clamping `max_tokens` to 1. `refreshState()` seeds every
 * draft from `/api/state` on load; until it answers, Nelle does not know what the
 * values are and should not guess.
 */
export const useSettingsStore = create<SettingsStore>(set => ({
  globalParamRows: [],
  isLogVisible: false,
  isSearching: false,
  modelAliasDrafts: {},
  modelParamRows: {},
  modelsMaxInput: '',
  reasoningBudgetInputs: budgetInputs(DEFAULT_REASONING_BUDGETS),
  runtimeLogs: '',
  searchQuery: 'qwen gguf',
  searchResults: [],
  sleepIdleInput: '',
  setGlobalParamRows: rows => set({globalParamRows: rows}),
  setIsLogVisible: isVisible => set({isLogVisible: isVisible}),
  setIsSearching: isSearching => set({isSearching}),
  setModelAliasDraft: (modelId, value) =>
    set(state => ({
      modelAliasDrafts: {...state.modelAliasDrafts, [modelId]: value},
    })),
  setModelParamRows: (modelId, rows) =>
    set(state => ({modelParamRows: {...state.modelParamRows, [modelId]: rows}})),
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
      globalParamRows: paramsToRows(globalParams ?? {}),
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
  resetGlobalParamRows: globalParams => set({globalParamRows: paramsToRows(globalParams ?? {})}),
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

  settingsSchema: [],
  settingsDrafts: {},
  settingsValues: {},
  settingsError: null,
  seedSettings: (schema, values) =>
    set({settingsSchema: schema, settingsDrafts: values, settingsValues: values}),
  setSettingsField: (slug, key, value) =>
    set(state => ({
      settingsDrafts: {
        ...state.settingsDrafts,
        [slug]: {...state.settingsDrafts[slug], [key]: value},
      },
      // The user changed something, so whatever the last save said is stale.
      settingsError: null,
    })),
  setSettingsError: message => set({settingsError: message}),
  resetSettingsDraft: (slug, values) =>
    set(state => ({
      settingsDrafts: {...state.settingsDrafts, [slug]: values},
      settingsValues: {...state.settingsValues, [slug]: values},
      settingsError: null,
    })),

  paramErrors: {},
  setParamErrors: (scope, invalid) =>
    set(state =>
      invalid.length === 0
        ? {paramErrors: without(state.paramErrors, scope)}
        : {paramErrors: {...state.paramErrors, [scope]: invalid}},
    ),
}));

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const next = {...record};
  delete next[key];
  return next;
}
