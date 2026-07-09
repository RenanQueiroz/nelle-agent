import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type {AppState, ChatMessage, ConfiguredModel, ModelParams} from './types';
import type {AppPaths} from './paths';
import {
  getModelsIniSectionValues,
  listModelsIniSections,
  parseModelsIni,
  removeModelsIniKeys,
  removeModelsIniSection,
  sectionIdForHuggingFaceRef,
  upsertModelsIniValues,
  writeModelsIniAtomic,
  type ModelsIniDocument,
} from '../../../packages/shared/src/modelsIni.ts';
import type {ReasoningBudgets} from '../../../packages/shared/src/reasoning.ts';
import {
  DEFAULT_REASONING_SETTINGS,
  normalizeReasoningBudgets,
} from '../../../packages/shared/src/reasoning.ts';

/**
 * llama.cpp itself is happy with 8k, but Nelle drives it through Pi, whose agent
 * system prompt costs ~4k tokens and whose max_tokens clamp reserves another 4k.
 * Anything below ~12k leaves no reply budget at all, so 8k produced one-word
 * answers. See `piContext.ts`. Kept at 16k rather than higher because KV cache
 * is allocated per slot and users on small GPUs must still be able to load a
 * model; raise it in Settings > Global Params when there is VRAM to spare.
 */
export const DEFAULT_CONTEXT_SIZE = 16_384;

/**
 * Read lazily: the e2e harness sets `NELLE_LLAMA_PORT` in its own module body,
 * which runs after this module's imports have already been evaluated.
 */
function defaultLlamaPort(): number {
  return Number(process.env.NELLE_LLAMA_PORT ?? 8080);
}

const DEFAULT_STATE: AppState = {
  version: 1,
  activeModelId: null,
  models: [],
  globalModelParams: {
    // Pi's agent system prompt is ~4k tokens and Pi reserves another 4k before
    // it will allocate any reply tokens, so an 8k window yields one-word answers.
    c: String(DEFAULT_CONTEXT_SIZE),
  },
  reasoning: DEFAULT_REASONING_SETTINGS,
  runtime: {
    host: '127.0.0.1',
    // Placeholder; `defaultLlamaPort()` is what actually applies. Overridable so
    // the e2e server does not health-probe (and adopt) a real llama-server that
    // a developer happens to be running on the usual port.
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
  },
  chat: [],
};

const DEFAULT_PARAMS: ModelParams = {
  contextSize: DEFAULT_CONTEXT_SIZE,
  extra: {},
};

export class AppStore {
  #state: AppState | null = null;

  constructor(private readonly paths: AppPaths) {}

  async load(): Promise<AppState> {
    if (this.#state) {
      return this.#state;
    }

    await this.ensureDirs();
    try {
      const raw = await fs.readFile(this.paths.statePath, 'utf8');
      this.#state = normalizeState(JSON.parse(raw) as Partial<AppState>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      this.#state = structuredClone(DEFAULT_STATE);
      this.#state.runtime.port = defaultLlamaPort();
      await this.save();
    }
    await this.syncModelCatalogFromPreset(this.#state);
    return this.#state;
  }

  async save(): Promise<void> {
    if (!this.#state) {
      return;
    }
    await this.ensureDirs();
    const tmp = `${this.paths.statePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(this.#state, null, 2)}\n`);
    await fs.rename(tmp, this.paths.statePath);
  }

  async ensureDirs(): Promise<void> {
    await Promise.all([
      fs.mkdir(path.dirname(this.paths.statePath), {recursive: true}),
      fs.mkdir(this.paths.downloadsDir, {recursive: true}),
      fs.mkdir(this.paths.llamaBinDir, {recursive: true}),
      fs.mkdir(path.dirname(this.paths.llamaLogPath), {recursive: true}),
      fs.mkdir(this.paths.piDir, {recursive: true}),
    ]);
  }

  async getState(): Promise<AppState> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    return structuredClone(state);
  }

  async getActiveModel(): Promise<ConfiguredModel | null> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    return state.models.find(model => model.id === state.activeModelId) ?? null;
  }

  async getModel(id: string): Promise<ConfiguredModel | null> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    return state.models.find(model => model.id === id) ?? null;
  }

  async setActiveModel(id: string): Promise<ConfiguredModel> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const model = state.models.find(item => item.id === id);
    if (!model) {
      throw new Error(`Unknown model: ${id}`);
    }
    state.activeModelId = id;
    await this.save();
    return model;
  }

  async addHuggingFaceModel(input: {
    repoId: string;
    quant: string;
    name?: string;
    params?: Partial<ModelParams>;
  }): Promise<ConfiguredModel> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const hfRef = `${input.repoId}:${input.quant}`;
    const existing = state.models.find(model => model.hfRef === hfRef);
    if (existing) {
      state.activeModelId = existing.id;
      await this.save();
      return existing;
    }

    const id = sectionIdForHuggingFaceRef(
      hfRef,
      state.models.map(model => ({sectionId: model.id, hfRepo: model.hfRef})),
    );
    const model: ConfiguredModel = {
      id,
      name: input.name ?? hfRef,
      presetName: id,
      source: 'huggingface',
      repoId: input.repoId,
      quant: input.quant,
      hfRef,
      params: {...DEFAULT_PARAMS, ...input.params},
      createdAt: new Date().toISOString(),
    };
    await this.upsertModelSection(model);
    await this.syncModelCatalogFromPreset(state);
    state.activeModelId = id;
    await this.save();
    return structuredClone(state.models.find(item => item.id === id) ?? model);
  }

  async updateGlobalModelParams(params: Record<string, string>): Promise<Record<string, string>> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const nextParams = normalizeParamRecord(params, DEFAULT_STATE.globalModelParams);
    await this.updateModelsIniDocument(document =>
      upsertModelsIniValues(document, '*', nextParams),
    );
    await this.syncModelCatalogFromPreset(state);
    await this.save();
    return structuredClone(state.globalModelParams);
  }

  async updateReasoningBudgets(budgets: unknown): Promise<ReasoningBudgets> {
    const state = await this.load();
    state.reasoning = {budgets: normalizeReasoningBudgets(budgets)};
    await this.save();
    return structuredClone(state.reasoning.budgets);
  }

  async updateModel(
    id: string,
    input: {
      name?: string;
      params?: Record<string, string>;
    },
  ): Promise<ConfiguredModel> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const index = state.models.findIndex(model => model.id === id);
    if (index < 0) {
      throw new Error(`Unknown model: ${id}`);
    }
    const globalContextSize = contextSizeFromParams(
      state.globalModelParams,
      DEFAULT_PARAMS.contextSize,
    );
    const previous = state.models[index]!;
    const next: ConfiguredModel = {
      ...previous,
      name: input.name?.trim() || previous.name,
      params:
        input.params == null
          ? previous.params
          : normalizeModelParams({extra: input.params}, globalContextSize),
    };
    await this.upsertModelSection(next, {replaceEditableParams: input.params != null});
    await this.syncModelCatalogFromPreset(state);
    await this.save();
    return structuredClone(state.models.find(model => model.id === id) ?? next);
  }

  async duplicateModel(id: string): Promise<ConfiguredModel> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const source = state.models.find(model => model.id === id);
    if (!source) {
      throw new Error(`Unknown model: ${id}`);
    }
    const copyId = uniqueModelId(`${source.id}-copy`, state.models);
    const copy: ConfiguredModel = {
      ...structuredClone(source),
      id: copyId,
      presetName: copyId,
      name: `${source.name} copy`,
      createdAt: new Date().toISOString(),
    };
    await this.upsertModelSection(copy);
    await this.syncModelCatalogFromPreset(state);
    state.activeModelId = copy.id;
    await this.save();
    return structuredClone(state.models.find(model => model.id === copy.id) ?? copy);
  }

  async removeModel(id: string): Promise<ConfiguredModel | null> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const index = state.models.findIndex(model => model.id === id);
    if (index < 0) {
      return null;
    }
    const removed = structuredClone(state.models[index]!);
    await this.updateModelsIniDocument(document => removeModelsIniSection(document, id));
    await this.syncModelCatalogFromPreset(state);
    if (state.activeModelId === id) {
      state.activeModelId = state.models[index]?.id ?? state.models[index - 1]?.id ?? null;
    }
    await this.save();
    return removed;
  }

  async updateRuntimeSettings(input: {
    modelsMax?: number;
    sleepIdleSeconds?: number;
  }): Promise<AppState['runtime']> {
    const state = await this.load();
    state.runtime = normalizeRuntime({...state.runtime, ...input});
    await this.save();
    return structuredClone(state.runtime);
  }

  async appendChatMessage(message: ChatMessage): Promise<void> {
    const state = await this.load();
    state.chat.push(message);
    state.chat = state.chat.slice(-100);
    await this.save();
  }

  async clearChat(): Promise<void> {
    const state = await this.load();
    state.chat = [];
    await this.save();
  }

  private async syncModelCatalogFromPreset(state: AppState): Promise<void> {
    const before = modelCatalogSignature(state);
    await this.ensureModelsIniFromState(state);
    const document = parseModelsIni(await this.readModelsIniText());
    const globalModelParams = getGlobalParamsFromModelsIni(document, state.globalModelParams);
    const models = getConfiguredModelsFromModelsIni(document, state.models, globalModelParams);
    state.globalModelParams = globalModelParams;
    state.models = models;
    state.activeModelId = models.some(model => model.id === state.activeModelId)
      ? state.activeModelId
      : (models[0]?.id ?? null);
    if (modelCatalogSignature(state) !== before) {
      await this.save();
    }
  }

  private async ensureModelsIniFromState(state: AppState): Promise<void> {
    const existing = await this.readModelsIniText();
    if (existing.length > 0) {
      return;
    }

    let document = parseModelsIni('');
    document = upsertModelsIniValues(document, null, {version: 1});
    document = upsertModelsIniValues(document, '*', state.globalModelParams);
    for (const model of state.models) {
      document = upsertModelsIniValues(document, model.id, modelSourceValues(model));
      document = removeModelsIniKeys(document, model.id, ['load-on-startup']);
    }
    await writeModelsIniAtomic(this.paths.llamaPresetPath, document);
  }

  private async upsertModelSection(
    model: ConfiguredModel,
    input: {replaceEditableParams?: boolean} = {},
  ): Promise<void> {
    await this.updateModelsIniDocument(document => {
      const sectionId = model.id;
      let next = document;
      if (input.replaceEditableParams) {
        const values = getModelsIniSectionValues(next, sectionId);
        const editableKeys = [...values.keys()].filter(key => !RESERVED_MODEL_KEYS.has(key));
        next = removeModelsIniKeys(next, sectionId, editableKeys);
      }
      next = upsertModelsIniValues(next, sectionId, modelSourceValues(model));
      return removeModelsIniKeys(next, sectionId, ['load-on-startup']);
    });
  }

  private async updateModelsIniDocument(
    update: (document: ModelsIniDocument) => ModelsIniDocument,
  ): Promise<void> {
    await this.ensureDirs();
    const document = update(parseModelsIni(await this.readModelsIniText()));
    await writeModelsIniAtomic(this.paths.llamaPresetPath, document);
  }

  private async readModelsIniText(): Promise<string> {
    try {
      return await fs.readFile(this.paths.llamaPresetPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }
}

function normalizeState(input: Partial<AppState>): AppState {
  const globalModelParams = normalizeParamRecord(
    input.globalModelParams,
    DEFAULT_STATE.globalModelParams,
  );
  const globalContextSize = contextSizeFromParams(globalModelParams, DEFAULT_PARAMS.contextSize);
  const models = (input.models ?? []).filter(isHuggingFaceModel).map(model => ({
    ...model,
    source: 'huggingface' as const,
    params: normalizeModelParams(model.params, globalContextSize),
    createdAt: model.createdAt ?? new Date().toISOString(),
  }));
  const activeModelId = models.some(model => model.id === input.activeModelId)
    ? (input.activeModelId ?? null)
    : (models[0]?.id ?? null);

  return {
    version: 1,
    activeModelId,
    models,
    globalModelParams,
    reasoning: {budgets: normalizeReasoningBudgets(input.reasoning?.budgets)},
    runtime: normalizeRuntime(input.runtime),
    chat: Array.isArray(input.chat) ? input.chat : [],
  };
}

const RESERVED_MODEL_KEYS = new Set(['hf-repo', 'alias', 'load-on-startup']);

function modelCatalogSignature(state: AppState): string {
  return JSON.stringify({
    activeModelId: state.activeModelId,
    globalModelParams: state.globalModelParams,
    models: state.models,
  });
}

function getGlobalParamsFromModelsIni(
  document: ModelsIniDocument,
  fallback: Record<string, string>,
): Record<string, string> {
  const values = getModelsIniSectionValues(document, '*');
  return normalizeParamRecord(Object.fromEntries(values), fallback);
}

function getConfiguredModelsFromModelsIni(
  document: ModelsIniDocument,
  previousModels: ConfiguredModel[],
  globalModelParams: Record<string, string>,
): ConfiguredModel[] {
  const previousById = new Map(previousModels.map(model => [model.id, model] as const));
  const globalContextSize = contextSizeFromParams(globalModelParams, DEFAULT_PARAMS.contextSize);
  const now = new Date().toISOString();
  return listModelsIniSections(document)
    .filter(sectionId => sectionId !== '*')
    .flatMap(sectionId => {
      const values = getModelsIniSectionValues(document, sectionId);
      const hfRef = values.get('hf-repo');
      if (!hfRef) {
        return [];
      }
      const previous = previousById.get(sectionId);
      const parsedRef = splitHuggingFaceRef(hfRef);
      const extra = Object.fromEntries(
        [...values.entries()].filter(([key]) => !RESERVED_MODEL_KEYS.has(key)),
      );
      return [
        {
          id: sectionId,
          name: values.get('alias')?.trim() || previous?.name || hfRef,
          presetName: sectionId,
          source: 'huggingface' as const,
          repoId: parsedRef?.repoId,
          quant: parsedRef?.quant,
          hfRef,
          params: normalizeModelParams({extra}, globalContextSize),
          createdAt: previous?.createdAt ?? now,
        },
      ];
    });
}

function modelSourceValues(model: ConfiguredModel): Record<string, string> {
  if (!model.hfRef) {
    throw new Error(`Model ${model.name} has no Hugging Face reference.`);
  }
  return {
    'hf-repo': model.hfRef,
    alias: model.name || model.hfRef,
    'stop-timeout': '10',
    ...(model.params.extra ?? {}),
  };
}

function splitHuggingFaceRef(ref: string): {repoId: string; quant: string} | null {
  const separator = ref.lastIndexOf(':');
  if (separator < 0) {
    return null;
  }
  const repoId = ref.slice(0, separator);
  const quant = ref.slice(separator + 1);
  if (!repoId || !quant) {
    return null;
  }
  return {repoId, quant};
}

function isHuggingFaceModel(model: ConfiguredModel): boolean {
  return (
    model.source === 'huggingface' && typeof model.hfRef === 'string' && model.hfRef.length > 0
  );
}

function normalizeRuntime(input: Partial<AppState['runtime']> = {}): AppState['runtime'] {
  return {
    host: input.host || DEFAULT_STATE.runtime.host,
    port: positiveInteger(input.port, defaultLlamaPort()),
    modelsMax: positiveInteger(input.modelsMax, DEFAULT_STATE.runtime.modelsMax),
    sleepIdleSeconds: nonNegativeInteger(
      input.sleepIdleSeconds,
      DEFAULT_STATE.runtime.sleepIdleSeconds,
    ),
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function normalizeModelParams(
  input: Partial<ModelParams> | undefined,
  fallbackContextSize: number,
): ModelParams {
  const extra = normalizeParamRecord(input?.extra, {});
  return {
    contextSize: positiveInteger(
      input?.contextSize,
      contextSizeFromParams(extra, fallbackContextSize),
    ),
    ...(input?.gpuLayers != null ? {gpuLayers: input.gpuLayers} : {}),
    ...(input?.threads != null ? {threads: input.threads} : {}),
    ...(input?.batchSize != null ? {batchSize: input.batchSize} : {}),
    extra,
  };
}

function normalizeParamRecord(
  input: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return {...fallback};
  }
  const entries = Object.entries(input)
    .map(([key, value]) => [key.trim(), String(value).trim()] as const)
    .filter(([key]) => key.length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : {...fallback};
}

function contextSizeFromParams(params: Record<string, string>, fallback: number): number {
  const value = Number.parseInt(params.c ?? params['ctx-size'] ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function uniqueModelId(base: string, models: ConfiguredModel[]): string {
  const existing = new Set(models.map(model => model.id));
  if (!existing.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\.gguf$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'model'
  );
}
