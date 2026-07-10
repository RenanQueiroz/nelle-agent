import type {ModelCacheRepository} from './modelCache';
import type {ConfiguredModel} from './types';

/**
 * What a conversation on this model actually gets, or `null` while unknown.
 *
 * `/props` is llama.cpp's own answer and always wins. It is cached in
 * `model_cache.context_window` on every successful props fetch, including the
 * one the server performs after it loads a model for a run. `kv_unified = true`,
 * so the number `/props` reports is the whole window each of the four slots
 * sees, not a share of it.
 *
 * The configured cap is only a prediction of what llama.cpp will do with a `c`
 * key. Before the first load it is all Nelle has; after it, it is stale.
 *
 * `null` means "never loaded and never capped". It is an honest answer and must
 * be handled as one, not papered over with a constant. In particular
 * `maxAffordableImages(0)` is `0`, which refuses every image, so coercing this
 * to a number is the way to break the image pre-flight silently.
 */
export function effectiveContextWindow(
  model: Pick<ConfiguredModel, 'id' | 'params'>,
  modelCache?: Pick<ModelCacheRepository, 'getModel'>,
): number | null {
  return modelCache?.getModel(model.id)?.contextWindow ?? model.params.contextSize ?? null;
}

/**
 * The same, for the two callers that cannot load a model first and so must not
 * ask Pi to guess: title generation and the direct-llama fallback.
 *
 * Pi bakes `contextWindow` into a session at construction and clamps against it
 * for the session's life, so it must never see `null`. The chat and regenerate
 * routes call `ensureModelReadyForRun` before `createChatStream`, which loads
 * the model and caches its props, so by the time `ensureSession` runs the window
 * is known.
 */
export function requireContextWindow(
  model: Pick<ConfiguredModel, 'id' | 'name' | 'params'>,
  modelCache?: Pick<ModelCacheRepository, 'getModel'>,
): number {
  const window = effectiveContextWindow(model, modelCache);
  if (window == null) {
    throw new Error(
      `${model.name} has no known context window. Load the model once so llama.cpp can report it, ` +
        `or set a context size in Settings > Global Params.`,
    );
  }
  return window;
}
