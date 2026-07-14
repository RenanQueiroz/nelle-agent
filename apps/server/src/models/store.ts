import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import type {AppState, ChatMessage, ConfiguredModel, ModelParams} from '../lib/types';
import type {AppPaths} from '../lib/paths';
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
} from '../contracts/modelsIni.ts';
import {PI_MINIMUM_CONTEXT_TOKENS} from '../contracts/piContext.ts';

/**
 * The `models.ini` keys that cap a model's context window.
 *
 * `common/preset.cpp` maps an option by every spelling and every env name, so
 * all three of these set `--ctx-size`. Nelle writes none of them.
 *
 * `c = 0` is not "the default": it tells llama.cpp the user explicitly wants the
 * full trained window, and disables the context reduction `--fit` would
 * otherwise do (`common/arg.cpp`). So it is not a cap either -- it is the
 * opposite of one.
 */
const CONTEXT_SIZE_KEYS = ['c', 'ctx-size', 'LLAMA_ARG_CTX_SIZE'] as const;

/**
 * `--fit-ctx`: the smallest window llama.cpp's auto-fit may settle on.
 *
 * `--fit` is on by default and adjusts an *unset* context to the memory it
 * finds, anywhere between this floor and the model's trained window. Measured on
 * gemma-4-26B (262,144 trained): with nothing set, llama.cpp chose llama.cpp's
 * own floor of 4,096 -- a window Pi's ~9,439-token system prompt does not fit
 * in, so every answer came back one token long. With `fitc = 16384` it chose
 * 16,384, and on a machine with more memory it would choose more.
 *
 * This is the one number Nelle writes, and it is a floor rather than a cap:
 * llama.cpp still decides the window, and still fails to load if even this does
 * not fit -- which is a legible failure rather than a silent uselessness.
 */
const FIT_CONTEXT_KEY = 'fitc';

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
  // Nelle used to write `c = 16384` here, capping gemma-4-26B at six percent of
  // the 262,144-token window it was trained for. It now writes a *floor* for
  // llama.cpp's auto-fit instead, and llama.cpp picks the window. What a
  // conversation actually gets is its to report, not Nelle's to assume.
  globalModelParams: {[FIT_CONTEXT_KEY]: String(PI_MINIMUM_CONTEXT_TOKENS)},
  runtime: {
    host: '127.0.0.1',
    // Placeholder; `defaultLlamaPort()` is what actually applies. Overridable so
    // the e2e server does not health-probe (and adopt) a real llama-server that
    // a developer happens to be running on the usual port.
    port: 8080,
  },
  chat: [],
};

const DEFAULT_PARAMS: ModelParams = {
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
      // A new import has no weights yet, so it must stay online long enough to fetch them.
      // Nelle pins it the moment it has loaded once -- see `configuredModelSchema.pinned`.
      pinned: false,
      diskBytes: null,
      params: {...DEFAULT_PARAMS, ...input.params},
      createdAt: new Date().toISOString(),
    };
    await this.upsertModelSection(model);
    await this.syncModelCatalogFromPreset(state);
    state.activeModelId = id;
    await this.save();
    return structuredClone(state.models.find(item => item.id === id) ?? model);
  }

  /**
   * A full replacement of the `[*]` section's params.
   *
   * Upserting instead left every key the payload omitted behind, so the context
   * cap could not be removed through the UI -- which is the one thing removing
   * the default has to allow.
   */
  async updateGlobalModelParams(params: Record<string, string>): Promise<Record<string, string>> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const nextParams = normalizeParamRecord(params, DEFAULT_STATE.globalModelParams);
    await this.updateModelsIniDocument(document => {
      const stale = [...getModelsIniSectionValues(document, '*').keys()].filter(
        key => !(key in nextParams),
      );
      return upsertModelsIniValues(removeModelsIniKeys(document, '*', stale), '*', nextParams);
    });
    await this.syncModelCatalogFromPreset(state);
    await this.save();
    return structuredClone(state.globalModelParams);
  }

  /**
   * Where llama.cpp listens. Host and port stay in `state.json`: they are the router's
   * address, not something a user sets in a settings screen -- and the e2e harness moves
   * the port so a developer's own llama-server is not adopted.
   *
   * The *limits* it is launched with (`modelsMax`, `sleepIdleSeconds`) are a settings
   * group now, and are not here.
   */
  async updateRuntimeSettings(input: {host?: string; port?: number}): Promise<AppState['runtime']> {
    const state = await this.load();
    state.runtime = normalizeRuntime({...state.runtime, ...input});
    await this.save();
    return structuredClone(state.runtime);
  }

  async updateModel(
    id: string,
    input: {
      name?: string;
      pinned?: boolean;
      params?: Record<string, string>;
    },
  ): Promise<ConfiguredModel> {
    const state = await this.load();
    await this.syncModelCatalogFromPreset(state);
    const index = state.models.findIndex(model => model.id === id);
    if (index < 0) {
      throw new Error(`Unknown model: ${id}`);
    }
    const globalContextSize = globalContextSizeFromParams(state.globalModelParams);
    const previous = state.models[index]!;
    const next: ConfiguredModel = {
      ...previous,
      name: input.name?.trim() || previous.name,
      pinned: input.pinned ?? previous.pinned,
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
      // An upsert can *add* a key but never remove one, so a Nelle-managed key that no
      // longer applies has to be struck explicitly. Un-pinning is exactly that: dropping
      // `offline` from `modelSourceValues` leaves the old `offline = 1` line in the file,
      // which reads straight back as `pinned: true` -- the un-pin silently does nothing.
      return removeModelsIniKeys(
        next,
        sectionId,
        model.pinned ? ['load-on-startup'] : ['load-on-startup', 'offline'],
      );
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
  const globalContextSize = globalContextSizeFromParams(globalModelParams);
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

/**
 * Keys Nelle manages, which therefore never appear in a model's editable params.
 *
 * `offline` is `pinned` (see `configuredModelSchema`). It is deliberately *not* a free-form
 * param: Nelle writes it after a successful load, so a user who deleted the row would watch
 * it come straight back -- the same fight `stop-timeout` used to pick. It is a field with a
 * switch, not a parameter with a value.
 */
const RESERVED_MODEL_KEYS = new Set(['hf-repo', 'alias', 'load-on-startup', 'offline']);

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
  const globalContextSize = globalContextSizeFromParams(globalModelParams);
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
          // `models.ini` is the source of truth for the pin, as it is for everything else.
          pinned: isTruthyIniValue(values.get('offline')),
          // The store does not touch the filesystem. Disk is a *view* of the model, filled in
          // where it leaves the server (`decorateModel`), which keeps this read synchronous.
          diskBytes: null,
          params: normalizeModelParams({extra}, globalContextSize),
          createdAt: previous?.createdAt ?? now,
        },
      ];
    });
}

/** `1`, `true`, `yes`, `on` -- however the user or Nelle wrote it. */
function isTruthyIniValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * The `models.ini` section for a model: what Nelle owns, plus the user's free-form params.
 *
 * **One copy, deliberately.** `llamacpp.ts` had its own identical version, and `writePreset`
 * used *that* one -- so a field added here (the `offline` pin) was written to state and then
 * silently stripped from the preset on the next write. Two copies of a serializer is a bug
 * with a delay fuse.
 */
export function modelSourceValues(model: ConfiguredModel): Record<string, string> {
  if (!model.hfRef) {
    throw new Error(`Model ${model.name} has no Hugging Face reference.`);
  }
  return {
    'hf-repo': model.hfRef,
    alias: model.name || model.hfRef,
    // Written only when pinned: `offline` also means "never download", so an unpinned
    // (not-yet-downloaded) model must be able to reach Hugging Face for its first fetch.
    ...(model.pinned ? {offline: '1'} : {}),
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
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * `contextSize` is the cap, and it is absent when there is none. llama.cpp's own
 * cascade applies the `[*]` section and then the model's, so a per-model `c`
 * overrides the global one and needs no storage of its own.
 */
function normalizeModelParams(
  input: Partial<ModelParams> | undefined,
  globalContextSize: number | null,
): ModelParams {
  const extra = normalizeParamRecord(input?.extra, {});
  // `undefined` means this section is silent, so `[*]` applies. `null` means it
  // wrote `c = 0`, which removes a global cap rather than inheriting it.
  const own = contextSizeFromParams(extra);
  const contextSize = own === undefined ? globalContextSize : own;
  return {
    ...(contextSize != null ? {contextSize} : {}),
    extra,
  };
}

/**
 * An absent `params` key means "the user sent nothing", and falls back. An empty
 * object means "the user removed everything", and does not.
 *
 * Conflating the two made the context cap unremovable through the UI: `PATCH
 * /api/models/global-params {"params":{}}` answered `{"c":"16384"}`.
 */
function normalizeParamRecord(
  input: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return {...fallback};
  }
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key.trim(), String(value).trim()] as const)
      .filter(([key]) => key.length > 0),
  );
}

/**
 * The context cap this section configures.
 *
 * Three answers, and the difference matters: `undefined` means the section says
 * nothing, so a caller cascades to `[*]`. `null` means it says `c = 0`, which is
 * llama.cpp's own way of spelling "loaded from model" -- an explicit *removal* of
 * a global cap, not a silent absence of one. A number is a cap.
 *
 * Even a cap is only a prediction of what llama.cpp will do. Once the model has
 * loaded, `/props` is the truth -- see `effectiveContextWindow`.
 */
function contextSizeFromParams(params: Record<string, string>): number | null | undefined {
  for (const key of CONTEXT_SIZE_KEYS) {
    const raw = params[key];
    if (raw === undefined) {
      continue;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  return undefined;
}

/** The `[*]` cap, where "says nothing" and "says no cap" mean the same thing. */
function globalContextSizeFromParams(params: Record<string, string>): number | null {
  return contextSizeFromParams(params) ?? null;
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
