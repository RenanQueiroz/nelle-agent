import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type {AppState, ChatMessage, ConfiguredModel, ModelParams} from './types';
import type {AppPaths} from './paths';
import {sectionIdForHuggingFaceRef} from '../../../packages/shared/src/modelsIni.ts';

const DEFAULT_STATE: AppState = {
  version: 1,
  activeModelId: null,
  models: [],
  globalModelParams: {
    c: '8192',
  },
  runtime: {
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
  },
  chat: [],
};

const DEFAULT_PARAMS: ModelParams = {
  contextSize: 8192,
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
      await this.save();
    }
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
    return structuredClone(await this.load());
  }

  async getActiveModel(): Promise<ConfiguredModel | null> {
    const state = await this.load();
    return state.models.find(model => model.id === state.activeModelId) ?? null;
  }

  async getModel(id: string): Promise<ConfiguredModel | null> {
    const state = await this.load();
    return state.models.find(model => model.id === id) ?? null;
  }

  async setActiveModel(id: string): Promise<ConfiguredModel> {
    const state = await this.load();
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
    state.models.push(model);
    state.activeModelId = model.id;
    await this.save();
    return model;
  }

  async updateGlobalModelParams(params: Record<string, string>): Promise<Record<string, string>> {
    const state = await this.load();
    state.globalModelParams = normalizeParamRecord(params, DEFAULT_STATE.globalModelParams);
    const globalContextSize = contextSizeFromParams(
      state.globalModelParams,
      DEFAULT_PARAMS.contextSize,
    );
    state.models = state.models.map(model => ({
      ...model,
      params: normalizeModelParams(model.params, globalContextSize),
    }));
    await this.save();
    return structuredClone(state.globalModelParams);
  }

  async updateModel(
    id: string,
    input: {
      name?: string;
      params?: Record<string, string>;
    },
  ): Promise<ConfiguredModel> {
    const state = await this.load();
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
    state.models[index] = next;
    await this.save();
    return structuredClone(next);
  }

  async duplicateModel(id: string): Promise<ConfiguredModel> {
    const state = await this.load();
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
    state.models.push(copy);
    state.activeModelId = copy.id;
    await this.save();
    return structuredClone(copy);
  }

  async removeModel(id: string): Promise<ConfiguredModel | null> {
    const state = await this.load();
    const index = state.models.findIndex(model => model.id === id);
    if (index < 0) {
      return null;
    }
    const [removed] = state.models.splice(index, 1);
    if (state.activeModelId === id) {
      state.activeModelId = state.models[index]?.id ?? state.models[index - 1]?.id ?? null;
    }
    await this.save();
    return structuredClone(removed!);
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
    runtime: normalizeRuntime(input.runtime),
    chat: Array.isArray(input.chat) ? input.chat : [],
  };
}

function isHuggingFaceModel(model: ConfiguredModel): boolean {
  return (
    model.source === 'huggingface' && typeof model.hfRef === 'string' && model.hfRef.length > 0
  );
}

function normalizeRuntime(input: Partial<AppState['runtime']> = {}): AppState['runtime'] {
  return {
    host: input.host || DEFAULT_STATE.runtime.host,
    port: positiveInteger(input.port, DEFAULT_STATE.runtime.port),
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
