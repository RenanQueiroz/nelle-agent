/**
 * How Nelle describes its models to Pi: `.pi/models.json`, and the provider id it is written
 * under.
 *
 * (Not to be confused with `../models/`, which is Nelle's own catalog. This file is the *Pi* half
 * -- one JSON document, rewritten whenever a session is created for a model.)
 */

import fs from 'node:fs/promises';

import {replyTokenBudget} from '../contracts/piContext.ts';
import {effectiveContextWindow, requireContextWindow} from '../llama/contextWindow';
import {localLlamaProxyBaseUrl} from '../llama/proxy';
import type {AppPaths} from '../lib/paths';
import type {ConfiguredModel} from '../lib/types';
import type {ModelCacheRepository} from '../models/cache';
import {llamaRuntimeModelId} from '../models/compat';
import {AppStore} from '../models/store';

export const PROVIDER_ID = 'nelle-llamacpp';

export async function writePiModels(
  paths: AppPaths,
  store: AppStore,
  activeModel: ConfiguredModel,
  modelCache: ModelCacheRepository | undefined,
): Promise<void> {
  await fs.mkdir(paths.piDir, {recursive: true});
  // Pi bakes `contextWindow` into a session at construction and clamps against
  // it for the session's life, so it must never see a number nobody believes.
  // The chat and regenerate routes load the model before this runs, which is
  // what makes the window known; the assertion states that invariant.
  const activeContextWindow = requireContextWindow(activeModel, modelCache);
  const state = await store.getState();
  const models = state.models.flatMap(model => {
    const contextWindow =
      model.id === activeModel.id ? activeContextWindow : effectiveContextWindow(model, modelCache);
    // Never loaded and never capped. Omit it rather than invent a window: Pi
    // only looks up the model it is about to run, and that one is loaded.
    if (contextWindow == null) {
      return [];
    }
    return [
      {
        id: llamaRuntimeModelId(model),
        name: model.name,
        // Whether a model can actually think is decided by its chat template,
        // not by its name. Declaring `reasoning` unlocks Pi's thinking levels
        // for every model; a template that ignores `enable_thinking` just
        // answers normally. `templateSupportsThinking` gates the UI control.
        reasoning: true,
        input: ['text', 'image'],
        contextWindow,
        // Pi clamps this against the live context, so advertise a generous
        // ceiling instead of a flat 512-token cap that truncated long answers.
        maxTokens: replyTokenBudget(contextWindow),
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
        // Pi hides `xhigh` unless the model maps it, and Nelle's `max` level
        // maps onto it. The value is never sent: `supportsReasoningEffort` is
        // false.
        thinkingLevelMap: {xhigh: 'xhigh'},
        // Pi's name for "pass `chat_template_kwargs.enable_thinking`", which
        // is how Qwen3, Gemma 4, and every llama.cpp thinking template read it.
        compat: {thinkingFormat: 'qwen-chat-template' as const},
      },
    ];
  });

  const config = {
    providers: {
      [PROVIDER_ID]: {
        baseUrl: localLlamaProxyBaseUrl(),
        api: 'openai-completions',
        apiKey: 'nelle-local',
        authHeader: false,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
        models,
      },
    },
    activeModel: llamaRuntimeModelId(activeModel),
  };

  await Bun.write(paths.piModelsPath, `${JSON.stringify(config, null, 2)}\n`);
}
