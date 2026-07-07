import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type {AppState, ChatMessage, ConfiguredModel, ModelParams} from './types';
import type {AppPaths} from './paths';

const DEFAULT_STATE: AppState = {
  version: 1,
  activeModelId: null,
  models: [],
  runtime: {
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
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
      this.#state = {...DEFAULT_STATE, ...JSON.parse(raw)} as AppState;
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
      fs.mkdir(this.paths.modelsDir, {recursive: true}),
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

  async addLocalModel(input: {
    name: string;
    modelPath: string;
    source: ConfiguredModel['source'];
    repoId?: string;
    filename?: string;
    params?: Partial<ModelParams>;
  }): Promise<ConfiguredModel> {
    const state = await this.load();
    const modelPath = path.resolve(input.modelPath);
    const id = crypto.randomUUID();
    const presetName = slugify(input.name || path.basename(modelPath));
    const model: ConfiguredModel = {
      id,
      name: input.name || path.basename(modelPath),
      presetName: uniquePresetName(
        presetName,
        state.models.map(item => item.presetName),
      ),
      source: input.source,
      repoId: input.repoId,
      filename: input.filename,
      path: modelPath,
      params: {...DEFAULT_PARAMS, ...input.params},
      createdAt: new Date().toISOString(),
    };
    state.models.push(model);
    state.activeModelId = model.id;
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

    const id = crypto.randomUUID();
    const model: ConfiguredModel = {
      id,
      name: input.name ?? hfRef,
      presetName: uniquePresetName(
        hfRef,
        state.models.map(item => item.presetName),
      ),
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

function uniquePresetName(base: string, existing: string[]): string {
  if (!existing.includes(base)) {
    return base;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!existing.includes(candidate)) {
      return candidate;
    }
  }
}
