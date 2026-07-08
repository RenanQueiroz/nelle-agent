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
  const models = (input.models ?? []).filter(isHuggingFaceModel).map(model => ({
    ...model,
    source: 'huggingface' as const,
    params: {...DEFAULT_PARAMS, ...(model.params ?? {})},
    createdAt: model.createdAt ?? new Date().toISOString(),
  }));
  const activeModelId = models.some(model => model.id === input.activeModelId)
    ? (input.activeModelId ?? null)
    : (models[0]?.id ?? null);

  return {
    version: 1,
    activeModelId,
    models,
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
