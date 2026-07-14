/**
 * llama.cpp's router, as an HTTP client.
 *
 * Everything Nelle asks the running llama-server *over HTTP*: `/props`, `/tokenize`, `/slots`,
 * and the `/models` family (list, load, unload, and the SSE stream). It owns no process — the
 * child, its pid file, and the install live with `LlamaCppManager`, which is why this needed
 * none of them and could leave.
 *
 * `runtime` is injected rather than imported: `getRouterProps` embeds the whole `RuntimeStatus`
 * in its answer, and that status is the manager's to report (it reads the last error and the
 * managed pid). Taking it as a callback is what keeps the dependency one-way.
 */

import type {AppPaths} from '../lib/paths';
import type {
  LlamaAbortVerificationResult,
  LlamaModelProps,
  LlamaRouterModel,
  LlamaRouterProps,
  LlamaTokenizeResult,
  RuntimeStatus,
} from '../lib/types';
import type {AppStore} from '../models/store';
import {templateSupportsThinking} from '../contracts/reasoning.ts';
import {routerLoadProgress} from '../contracts/routerProgress.ts';
import {readConfiguredModelSections} from './preset.ts';
import {
  booleanOrFalse,
  delay,
  getProp,
  numberOrNull,
  routerExitCode,
  stringOrUndefined,
} from './wire.ts';

type LlamaSlotSnapshot = {
  id?: number;
  id_task?: number;
  is_processing?: boolean;
  next_token?: Array<{
    has_next_token?: boolean;
    n_decoded?: number;
  }>;
};

export class LlamaRouterClient {
  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly runtime: () => Promise<RuntimeStatus>,
  ) {}

  async getRouterProps(): Promise<LlamaRouterProps> {
    const raw = await this.fetchRouterJson('/props');
    return {
      role: stringOrNull(getProp(raw, 'role')),
      maxInstances: numberOrNull(getProp(raw, 'max_instances') ?? getProp(raw, 'maxInstances')),
      modelsAutoload: booleanOrNull(
        getProp(raw, 'models_autoload') ?? getProp(raw, 'modelsAutoload'),
      ),
      runtime: await this.runtime(),
      raw,
    };
  }

  async getModelProps(modelId: string): Promise<LlamaModelProps> {
    const raw = await this.fetchRouterJson(
      `/props?model=${encodeURIComponent(modelId)}&autoload=false`,
    );
    const defaultGenerationSettings =
      getProp(raw, 'default_generation_settings') ?? getProp(raw, 'defaultGenerationSettings');
    const modalities = getProp(raw, 'modalities');
    const contextWindow =
      numberOrNull(getProp(defaultGenerationSettings, 'n_ctx')) ??
      numberOrNull(getProp(defaultGenerationSettings, 'nCtx')) ??
      numberOrNull(getProp(raw, 'n_ctx')) ??
      numberOrNull(getProp(raw, 'nCtx'));

    const chatTemplate = stringOrUndefined(
      getProp(raw, 'chat_template') ?? getProp(raw, 'chatTemplate'),
    );

    return {
      modelId,
      modalities: {
        vision: booleanOrFalse(getProp(modalities, 'vision') ?? getProp(raw, 'vision')),
        audio: booleanOrFalse(getProp(modalities, 'audio') ?? getProp(raw, 'audio')),
        video: booleanOrFalse(getProp(modalities, 'video') ?? getProp(raw, 'video')),
      },
      contextWindow: contextWindow ?? undefined,
      chatTemplate,
      // Whether a model can think is a property of its chat template, and only
      // llama.cpp has it. No template reported means unknown, not "cannot".
      canReason: chatTemplate == null ? null : templateSupportsThinking(chatTemplate),
      defaultGenerationSettings,
      raw,
    };
  }

  async tokenize(
    content: string,
    input: {
      addSpecial?: boolean;
      parseSpecial?: boolean;
      withPieces?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<LlamaTokenizeResult> {
    const raw = await this.fetchRouterJson('/tokenize', {
      method: 'POST',
      body: {
        content,
        add_special: input.addSpecial ?? false,
        parse_special: input.parseSpecial ?? true,
        with_pieces: input.withPieces ?? false,
      },
      signal: input.signal,
    });
    const tokens = getProp(raw, 'tokens');
    if (!Array.isArray(tokens)) {
      throw new Error('llama.cpp tokenize response did not include a tokens array.');
    }
    return {
      tokens: tokens.length,
      raw,
    };
  }

  async verifyAbortIdle(
    input: {modelId?: string; graceMs?: number; pollMs?: number} = {},
  ): Promise<LlamaAbortVerificationResult> {
    const graceMs = Math.max(0, input.graceMs ?? 5000);
    const pollMs = Math.min(Math.max(input.pollMs ?? 250, 50), 1000);
    const deadline = Date.now() + graceMs;
    let lastSlot: LlamaSlotSnapshot | null = null;

    for (;;) {
      const result = await this.fetchProcessingSlot(input.modelId);
      if (!result.checked) {
        return {checked: false, idle: true};
      }
      if (!result.slot) {
        return {checked: true, idle: true};
      }

      lastSlot = result.slot;
      if (Date.now() >= deadline) {
        const slotLabel = lastSlot.id == null ? 'unknown slot' : `slot ${lastSlot.id}`;
        const taskLabel = lastSlot.id_task == null ? '' : ` task ${lastSlot.id_task}`;
        return {
          checked: true,
          idle: false,
          warning: {
            code: 'llama_slot_still_processing',
            message:
              'llama.cpp still reports an active generation after stop. Open Settings > Runtime to stop or restart llama.cpp if it does not settle.',
            detail: `${input.modelId ?? 'selected model'} still has ${slotLabel}${taskLabel} processing after ${graceMs} ms.`,
            retryable: true,
          },
        };
      }

      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async getRouterModels(input: {reload?: boolean} = {}): Promise<{
    models: LlamaRouterModel[];
    raw: unknown;
  }> {
    const raw = await this.fetchRouterJson(input.reload ? '/models?reload=1' : '/models');
    return {
      models: await this.mergeRouterModels(raw),
      raw,
    };
  }

  async loadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return {
      modelId,
      raw: await this.fetchRouterJson('/models/load', {
        method: 'POST',
        body: {model: modelId},
      }),
    };
  }

  async unloadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return {
      modelId,
      raw: await this.fetchRouterJson('/models/unload', {
        method: 'POST',
        body: {model: modelId},
      }),
    };
  }

  async fetchRouterStream(pathname: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchRouter(pathname, {signal});
  }

  private async mergeRouterModels(raw: unknown): Promise<LlamaRouterModel[]> {
    const configured = await this.readConfiguredModelSections();
    const routerModels = extractRouterModelRecords(raw);
    const bySection = new Map<string, LlamaRouterModel>();

    for (const configuredModel of configured) {
      bySection.set(configuredModel.sectionId, {
        sectionId: configuredModel.sectionId,
        alias: configuredModel.alias ?? configuredModel.hfRepo ?? configuredModel.sectionId,
        hfRepo: configuredModel.hfRepo,
        status: 'unloaded',
        aliases: [],
      });
    }

    for (const routerModel of routerModels) {
      const normalized = normalizeRouterModel(routerModel);
      const sectionId = findConfiguredSectionId(normalized, configured);
      // **`models.ini` is the catalog, and llama.cpp's router is not.** Its
      // `server_models::load_models()` calls `load_from_cache()` unconditionally -- there
      // is no flag to turn it off -- so it advertises every GGUF sitting in the download
      // cache as a loadable model, plus a synthetic `default`. Observed live: six models
      // against a four-section preset. Those extras are not Nelle's: they have no params,
      // no `/api/models` row, no Pi entry, and nothing can manage them. Drop them.
      //
      // A configured model the router has *not* listed still appears -- it was seeded
      // above as `unloaded` -- so this only removes models Nelle never configured, never
      // hides one it did.
      if (!sectionId) {
        continue;
      }
      const previous = bySection.get(sectionId);
      bySection.set(sectionId, {
        ...previous,
        ...normalized,
        sectionId,
        routerModelId: normalized.routerModelId ?? normalized.sectionId,
        alias: previous?.alias ?? normalized.alias,
        hfRepo: previous?.hfRepo ?? normalized.hfRepo,
        aliases: normalized.aliases,
      });
    }

    return Array.from(bySection.values()).sort((left, right) =>
      left.alias.localeCompare(right.alias),
    );
  }

  private async readConfiguredModelSections(): Promise<
    Array<{sectionId: string; alias?: string; hfRepo?: string}>
  > {
    return readConfiguredModelSections(this.paths, this.store);
  }

  private async fetchRouterJson(
    pathname: string,
    input: {method?: string; body?: unknown; signal?: AbortSignal} = {},
  ): Promise<unknown> {
    const response = await this.fetchRouter(pathname, {
      method: input.method,
      body: input.body,
      signal: input.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `llama.cpp router request failed: ${response.status}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async fetchRouter(
    pathname: string,
    input: {method?: string; body?: unknown; signal?: AbortSignal} = {},
  ): Promise<Response> {
    const state = await this.store.getState();
    const url = new URL(`http://${state.runtime.host}:${state.runtime.port}${pathname}`);
    const response = await fetch(url, {
      method: input.method ?? 'GET',
      headers: input.body == null ? undefined : {'content-type': 'application/json'},
      body: input.body == null ? undefined : JSON.stringify(input.body),
      signal: input.signal,
    });
    return response;
  }

  private async fetchProcessingSlot(
    modelId?: string,
  ): Promise<{checked: boolean; slot: LlamaSlotSnapshot | null}> {
    const pathname = modelId ? `/slots?model=${encodeURIComponent(modelId)}` : '/slots';
    try {
      const response = await this.fetchRouter(pathname);
      if (response.status === 404 || response.status === 405) {
        return {checked: false, slot: null};
      }
      if (!response.ok) {
        return {checked: false, slot: null};
      }
      const slots = (await response.json()) as unknown;
      if (!Array.isArray(slots)) {
        return {checked: false, slot: null};
      }
      return {
        checked: true,
        slot: findProcessingSlot(slots),
      };
    } catch {
      return {checked: false, slot: null};
    }
  }
}

function extractRouterModelRecords(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const data = getProp(raw, 'data');
  if (Array.isArray(data)) {
    return data;
  }
  const models = getProp(raw, 'models');
  if (Array.isArray(models)) {
    return models;
  }
  return [];
}

function normalizeRouterModel(raw: unknown): LlamaRouterModel {
  const id =
    stringOrUndefined(getProp(raw, 'id')) ??
    stringOrUndefined(getProp(raw, 'model')) ??
    stringOrUndefined(getProp(raw, 'name')) ??
    'unknown';
  const aliases = arrayOfStrings(getProp(raw, 'aliases'));
  const statusValue = getProp(getProp(raw, 'status'), 'value') ?? getProp(raw, 'status');

  return {
    sectionId: id,
    routerModelId: id,
    alias: aliases[0] ?? id,
    hfRepo:
      stringOrUndefined(getProp(raw, 'hf_repo')) ??
      stringOrUndefined(getProp(raw, 'hfRepo')) ??
      stringOrUndefined(getProp(raw, 'source')),
    status: stringOrUndefined(statusValue) ?? 'unknown',
    // llama.cpp reports progress per *stage*, as an object, so reading it as a plain
    // number silently dropped every measurement and left clients with no percentage.
    progress: routerLoadProgress(
      getProp(raw, 'progress') ?? getProp(getProp(raw, 'status'), 'progress'),
    ),
    aliases,
    source: stringOrUndefined(getProp(raw, 'source')),
    canRemove: booleanOrNull(getProp(raw, 'can_remove') ?? getProp(raw, 'canRemove')) ?? undefined,
    architecture: stringOrUndefined(getProp(raw, 'architecture')),
    // The router's own record of how this model's last child process ended. Served rather than
    // left in `raw`, because it is the *only* evidence a load failed instantly: a child that
    // dies at startup is never marked `failed`, it stays `unloaded` carrying this. A client
    // must not have to reach into `raw` to find that out -- that is how every client ends up
    // re-deriving llama.cpp's shape.
    exitCode: routerExitCode(raw) ?? undefined,
    raw,
  };
}

function findConfiguredSectionId(
  routerModel: LlamaRouterModel,
  configured: Array<{sectionId: string; hfRepo?: string}>,
): string | null {
  for (const item of configured) {
    if (
      item.sectionId === routerModel.sectionId ||
      item.sectionId === routerModel.routerModelId ||
      routerModel.aliases.includes(item.sectionId) ||
      (item.hfRepo != null && item.hfRepo === routerModel.hfRepo)
    ) {
      return item.sectionId;
    }
  }
  return null;
}

function findProcessingSlot(slots: unknown[]): LlamaSlotSnapshot | null {
  return (
    (slots.find(slot => {
      const item = slot as LlamaSlotSnapshot;
      return (
        item.is_processing === true ||
        item.next_token?.some(token => token.has_next_token === true) === true
      );
    }) as LlamaSlotSnapshot | undefined) ?? null
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(item => typeof item === 'string');
}
