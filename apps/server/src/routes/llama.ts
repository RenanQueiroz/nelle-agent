import {z} from 'zod';

import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import {json, type Router} from '../http/router';
import {cacheModelPropsAfterLoad} from '../llama/modelReady';
import {recordModelProps} from '../llama/modelProps';
import type {RouteDeps} from './deps';

const tokenizeSchema = z.object({
  content: z.string().max(200_000),
  addSpecial: z.boolean().optional(),
  parseSpecial: z.boolean().optional(),
  withPieces: z.boolean().optional(),
});

/**
 * Nelle's facade over llama.cpp's router.
 *
 * Nothing else talks to llama.cpp: it is Nelle's child process, on a port Nelle chose, and
 * only Nelle knows whether it is up and which of its models it configured. A client asks
 * here.
 *
 * `GET /api/llama/params` is *not* here, and that is deliberate -- it is registered by the
 * models module, beside the params routes it is the accept-set for.
 */
export function registerLlamaRoutes(router: Router, deps: RouteDeps): void {
  const {llama, modelCache, ggufMetadata, log} = deps;

  router.get('/api/llama/props', async () => handleLlamaRoute(() => llama.getRouterProps()));

  router.get('/api/llama/models', async () =>
    handleLlamaRoute(async () => {
      const result = await llama.getRouterModels();
      modelCache.upsertRouterModels(result.models);
      // Both windows, so a client renders "Full window: 262,144 · running at
      // 16,384" without re-deriving either from `raw`. `contextWindow` is
      // llama.cpp's `/props` answer and `contextTrain` its `n_ctx_train`; both
      // are `undefined` until the model has been loaded once.
      return {
        ...result,
        models: result.models.map(model => {
          const cached = modelCache.getModel(model.sectionId);
          // The router only reports `n_ctx_train` for a model it has loaded. The
          // GGUF header knows it without the network, and without a load.
          const parsed = cached?.modelOid ? ggufMetadata.get(cached.modelOid) : null;
          return {
            ...model,
            contextWindow: cached?.contextWindow,
            contextTrain: cached?.contextTrain ?? parsed?.contextTrain,
            architecture: model.architecture ?? parsed?.architecture,
            parameterCount: parsed?.parameterCount,
          };
        }),
      };
    }),
  );

  router.post('/api/llama/models/reload', async () =>
    handleLlamaRoute(async () => {
      const result = await llama.getRouterModels({reload: true});
      modelCache.upsertRouterModels(result.models);
      return result;
    }),
  );

  router.get('/api/llama/models/events', async ctx => {
    let upstream: Response;
    try {
      // `ctx.req.signal` aborts when the client drops, aborting the upstream fetch.
      upstream = await llama.fetchRouterStream('/models/sse', ctx.req.signal);
    } catch (error) {
      return llamaError(error);
    }
    if (!upstream.ok || !upstream.body) {
      return llamaError(
        new Error(
          upstream.body
            ? `llama.cpp router events failed: ${upstream.status}`
            : 'llama.cpp router events response did not include a stream.',
        ),
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  });

  router.get('/api/llama/models/:id/props', async ctx => {
    const id = ctx.params.id;
    return handleLlamaRoute(async () => {
      const props = await llama.getModelProps(id);
      // A sleeping model answers /props with an error, so only a success caches.
      await recordModelProps({
        sectionId: id,
        props,
        modelCache,
        ggufMetadata,
        onError: error => log.warn({err: error, modelId: id}, 'could not parse the GGUF header'),
      });
      return props;
    });
  });

  router.post('/api/llama/tokenize', async ctx => {
    const body = tokenizeSchema.parse(await ctx.body());
    return handleLlamaRoute(() => llama.tokenize(body.content, body));
  });

  /**
   * Loads a model, and **waits for it**, because a load that has not finished has not happened.
   *
   * This used to proxy `POST /models/load` straight through, which answers `{success: true}` the
   * moment the router accepts the *request*. Three things fell out of that, and all three were
   * live:
   *
   * 1. A child that dies at startup is never marked `failed` -- it is left at `unloaded` with an
   *    exit code -- so a Load that failed was indistinguishable from a Load that did nothing.
   * 2. **The model was never pinned.** `pinToDownloadedWeights` runs on a *successful* load, and
   *    a successful load is the only moment pinning is both safe and possible. Only
   *    `ensureModelRunnable` did it, so a model loaded from Settings stayed unpinned while the
   *    same model loaded by a chat run got pinned -- the same button, two different outcomes.
   * 3. It reported success for a model that was still loading, which is simply not true.
   *
   * `ensureModelRunnable` is what a chat run already calls. Settings should not have its own,
   * worse copy of it.
   */
  router.post('/api/llama/models/:id/load', async ctx =>
    handleLlamaRoute(
      // `modelId` stays in the answer: the shape is the contract, and nothing about waiting for
      // the load is a reason to take a field away from a client that reads it. `loaded` is
      // `false` when the model was already runnable -- a load that was not needed, not one that
      // failed, which throws.
      async () => {
        const result = await llama.ensureModelRunnable(ctx.params.id);
        if (result.loaded) {
          // The same thing a run does. Without it, a model loaded from Settings sits there
          // `loaded` with no architecture, no context window, and its capabilities unknown.
          await cacheModelPropsAfterLoad({
            llama,
            modelCache,
            ggufMetadata,
            modelId: ctx.params.id,
            log,
          });
        }
        return {modelId: ctx.params.id, ...result};
      },
      NELLE_ERROR_CODES.modelLoadFailed,
    ),
  );

  router.post('/api/llama/models/:id/unload', async ctx =>
    handleLlamaRoute(() => llama.unloadRouterModel(ctx.params.id)),
  );
}

async function handleLlamaRoute<T>(
  action: () => Promise<T>,
  code = 'llama_router_request_failed',
): Promise<Response> {
  try {
    return json(await action());
  } catch (error) {
    return llamaError(error, code);
  }
}

function llamaError(error: unknown, code = 'llama_router_request_failed'): Response {
  return json(
    {
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    },
    502,
  );
}
