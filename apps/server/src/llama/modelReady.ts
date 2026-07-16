import type {ChatStreamEvent} from '../lib/types';
import type {GgufMetadataRepository} from '../models/gguf';
import type {ModelCacheRepository} from '../models/cache';
import type {LlamaCppManager} from './manager';
import {recordModelProps} from './modelProps';

/**
 * Makes the requested model runnable, streaming progress while it loads.
 *
 * The browser used to do this: post a load, poll `/models` sixty times at half a
 * second, watch for `failed`, give up at thirty. Every client would have copied
 * it. Now the run waits here and reports what it is waiting for.
 *
 * The props fetch afterwards is not incidental. `GET /api/llama/models/:id/props`
 * was the only writer of `model_cache`'s modality and context columns, and it
 * fires because a client asked. Once the server loads models itself, nothing asks,
 * and every capability derived from props degrades to "unknown" for exactly the
 * thin client this exists to serve.
 */
export async function ensureModelReadyForRun(input: {
  llama: LlamaCppManager;
  modelCache: ModelCacheRepository;
  ggufMetadata: GgufMetadataRepository;
  conversationId: string;
  modelId: string;
  write: (event: ChatStreamEvent) => void;
  log: {warn: (input: unknown, message?: string) => void};
}): Promise<void> {
  const result = await input.llama.ensureModelRunnable(input.modelId, {
    onProgress: update =>
      input.write({
        type: 'model.loading',
        conversationId: input.conversationId,
        modelId: input.modelId,
        status: update.status,
        progress: update.progress,
        phase: update.phase,
        downloadedBytes: update.downloadedBytes,
        totalBytes: update.totalBytes,
        createdAt: new Date().toISOString(),
      }),
  });
  // **Cache the props whenever we have not got them -- not only when we just loaded.**
  //
  // `ensureModelRunnable` answers `{loaded: false}` for a model that was *already* runnable, and
  // `sleeping` counts as runnable (llama.cpp wakes it on demand). So a model llama.cpp already has
  // resident never took the load path, never cached its props, and Pi then refused every run with
  // "has no known context window" -- an error whose own advice ("load the model once") the server
  // had just silently declined to follow.
  //
  // That is not exotic: it is any fresh `model_cache` against a llama.cpp that already knows the
  // model -- a reinstall, a deleted `settings.sqlite`, a router that auto-loaded on startup. It is
  // exactly what the M9 fixture is, which is how it was found.
  //
  // `/props` 502s for a genuinely `unloaded` model, and `cacheModelPropsAfterLoad` swallows that:
  // losing the cache entry costs a capability, never the run.
  const known = input.modelCache.getModel(input.modelId)?.contextWindow != null;
  if (result.loaded || !known) {
    await cacheModelPropsAfterLoad(input);
  }
}

/**
 * Caches what llama.cpp will now say about a model it has just loaded.
 *
 * **Every path that loads a model must call this**, and for a while only the chat run did. The
 * `/props` route is otherwise the *only* writer of `model_cache`'s modality and context columns,
 * and it fires because a client asked — so a model loaded from Settings had no architecture, no
 * context window, and a `canReason`/`canAttachImages` of "unknown", for ever, while sitting there
 * plainly loaded. (Driven: a freshly imported model loaded from Settings, and its own detail
 * screen still said its architecture was unknown.)
 *
 * A model that will not describe itself can still answer a prompt: losing the cache entry costs a
 * capability, never the load.
 */
export async function cacheModelPropsAfterLoad(input: {
  llama: LlamaCppManager;
  modelCache: ModelCacheRepository;
  ggufMetadata: GgufMetadataRepository;
  modelId: string;
  log: {warn: (input: unknown, message?: string) => void};
}): Promise<void> {
  try {
    await recordModelProps({
      sectionId: input.modelId,
      props: await input.llama.getModelProps(input.modelId),
      modelCache: input.modelCache,
      ggufMetadata: input.ggufMetadata,
      onError: error =>
        input.log.warn({err: error, modelId: input.modelId}, 'could not parse the GGUF header'),
    });
  } catch (error) {
    input.log.warn({err: error, modelId: input.modelId}, 'could not cache model props after load');
  }
}
