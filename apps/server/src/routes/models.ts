import {z} from 'zod';

import type {NelleError} from '../contracts/contracts.ts';
import type {ModelCatalogContract} from '../contracts/modelCatalog.ts';
import {
  invalidModelParamsCode,
  invalidModelParamsMessage,
  validateModelParams,
  modelParamWarnings,
  type ModelParamWarning,
  type InvalidModelParam,
} from '../contracts/modelParams.ts';
import {json, type Router} from '../http/router';
import type {ConfiguredModel} from '../lib/types';
import type {LlamaCppManager} from '../llama/manager';
import {ownsModelCache, removeRepoWeights, repoDiskBytes} from '../llama/weights';
import type {ModelCacheRepository} from '../models/cache';
import type {AppStore} from '../models/store';
import type {RouteDeps} from './deps';

const editableParamsSchema = z.record(z.string(), z.string());

const updateGlobalModelParamsSchema = z.object({
  params: editableParamsSchema,
});

const updateModelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /**
   * `false` lets the next load re-check Hugging Face, so an upstream fix can land. It
   * re-pins itself once that load succeeds -- an update is a deliberate act, not a standing
   * exposure. See `configuredModelSchema.pinned`.
   */
  pinned: z.boolean().optional(),
  params: editableParamsSchema.optional(),
});

/**
 * The `models.ini` catalog: what Nelle has configured, and every mutation of it.
 *
 * `GET /api/llama/params` is registered here rather than with the other `/api/llama/*` routes.
 * It is llama-server's own `--help`, parsed -- the accept-set `validateModelParams` checks a
 * key against two routes below, through the same `llamaOptions` cache. Keys are validated
 * against the binary, never against a list Nelle carries.
 */
export function registerModelRoutes(router: Router, deps: RouteDeps): void {
  const {paths, store, modelCache, ggufMetadata, llama, llamaOptions} = deps;

  /**
   * The `models.ini` catalog. Every mutation below answers with this same shape, because
   * every one of them can move more than the row it touched: a duplicate becomes the
   * active model, deleting the active one promotes a neighbour, and editing `[*]` changes
   * the derived `contextSize` of every model at once. So a client *applies* the catalog
   * rather than patching one row and guessing at the rest.
   */
  /**
   * Fills in what the store deliberately does not know: what this model's weights cost on
   * disk. `null` when nothing has been downloaded, or when the user pointed llama.cpp at a
   * cache of their own -- Nelle will neither measure nor delete a directory it does not own.
   */
  const decorateModel = async (model: ConfiguredModel): Promise<ConfiguredModel> => {
    // What llama.cpp last said about this model, from `model_cache`. **This is the whole point
    // of the cache**: a stopped llama-server leaves the rows alone, so a model that has loaded
    // once still knows its architecture and its windows. Without it a client reading only the
    // live router forgets everything the moment llama.cpp stops -- and then tells the user these
    // facts are "unknown until this model has loaded once", which by then is a lie.
    //
    // The router still wins when it is up: a client overlays the live status on this, exactly
    // as it already does for `status`.
    const cached = modelCache.getModel(model.id);
    // `architecture` and the parameter count come from the GGUF header, cached by the blob's
    // oid -- which `model_cache` records on a successful load. Both tables outlive a stopped
    // llama.cpp, which is the entire reason they exist.
    const gguf = cached?.modelOid ? ggufMetadata.get(cached.modelOid) : null;
    return {
      ...model,
      diskBytes:
        ownsModelCache() && model.repoId
          ? await repoDiskBytes(paths.modelsDir, model.repoId)
          : null,
      architecture: gguf?.architecture,
      parameterCount: gguf?.parameterCount,
      contextWindow: cached?.contextWindow,
      // The trained window: llama.cpp's `n_ctx_train` if it has loaded the model, else the GGUF
      // header's own answer, which is the same number from the same file.
      contextTrain: cached?.contextTrain ?? gguf?.contextTrain,
    };
  };

  const modelCatalog = async (): Promise<ModelCatalogContract> => {
    const state = await store.getState();
    return {
      models: await Promise.all(state.models.map(decorateModel)),
      activeModelId: state.activeModelId,
      globalModelParams: state.globalModelParams,
    };
  };

  router.get('/api/models', async () => json(await modelCatalog()));

  router.post('/api/models/:id/activate', async ctx => {
    const model = await store.setActiveModel(ctx.params.id);
    await llama.writePreset(model);
    return json({model: await decorateModel(model), catalog: await modelCatalog()});
  });

  // Served so a settings UI can offer completion, and so no client carries a copy
  // of llama.cpp's argument list that goes stale on the next upgrade.
  router.get('/api/llama/params', async () => json(await llamaOptions.get()));

  // **Registered before `PATCH /api/models/:id`, and it must stay there.** `Router.dispatch`
  // matches in insertion order and `:id` compiles to `([^/]+)`, so the other way round
  // `global-params` is swallowed as a model id. This is the only such pair in the table.
  router.patch('/api/models/global-params', async ctx => {
    const body = updateGlobalModelParamsSchema.parse(await ctx.body());
    const invalid = validateModelParams(body.params, {
      acceptedKeys: await llamaOptions.acceptedKeys(),
    });
    if (invalid.length > 0) {
      return json(invalidModelParamsResponse(invalid), 400);
    }
    const globalModelParams = await store.updateGlobalModelParams(body.params);
    await writePresetAndReloadRouter(llama, store, modelCache);
    // `globalModelParams` stays for the browser, which reads it directly. The catalog is
    // what a client should apply: `[*]` cascades, so this edit may have changed the
    // predicted `contextSize` of every model in the list.
    return json({globalModelParams, catalog: await modelCatalog()});
  });

  router.patch('/api/models/:id', async ctx => {
    const id = ctx.params.id;
    const body = updateModelSchema.parse(await ctx.body());
    // llama.cpp reports `n_ctx_train` once it has loaded the model, and it is cached here.
    // `null` for a model it never has, which leaves the context ceiling unenforced -- see
    // `MAX_CONTEXT_EXTENSION_FACTOR`.
    const trainedContextWindow = modelCache.getModel(id)?.contextTrain ?? null;
    let warnings: ModelParamWarning[] = [];
    if (body.params) {
      const invalid = validateModelParams(body.params, {
        // `offline` is the `pinned` field, and Nelle writes it after a successful load -- a
        // user who set it here would watch it be overwritten, and one who deleted it would
        // watch it come back. It has a switch, not a text box.
        reservedKeys: new Set(['hf-repo', 'alias', 'offline']),
        acceptedKeys: await llamaOptions.acceptedKeys(),
        trainedContextWindow,
      });
      if (invalid.length > 0) {
        return json(invalidModelParamsResponse(invalid), 400);
      }
      warnings = modelParamWarnings(body.params, trainedContextWindow);
    }
    let model;
    try {
      model = await store.updateModel(id, body);
    } catch (error) {
      return json(
        {
          error: {
            code: 'model_not_found',
            message: error instanceof Error ? error.message : `Unknown model: ${id}`,
          },
        },
        404,
      );
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    // `warnings` is what the save *did*, not why it failed: a context past the trained window
    // is legitimate (RoPE/YaRN) and llama.cpp itself only warns, so the value lands and the
    // user is told what they asked for. Absent when there is nothing to say.
    return json({
      model: await decorateModel(model),
      catalog: await modelCatalog(),
      ...(warnings.length > 0 ? {warnings} : {}),
    });
  });

  router.post('/api/models/:id/duplicate', async ctx => {
    const id = ctx.params.id;
    let model;
    try {
      model = await store.duplicateModel(id);
    } catch (error) {
      return json(
        {
          error: {
            code: 'model_not_found',
            message: error instanceof Error ? error.message : `Unknown model: ${id}`,
          },
        },
        404,
      );
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({model: await decorateModel(model), catalog: await modelCatalog()});
  });

  router.delete('/api/models/:id', async ctx => {
    const id = ctx.params.id;
    const removed = await store.removeModel(id);
    if (!removed) {
      return json({error: {code: 'model_not_found', message: `Unknown model: ${id}`}}, 404);
    }
    await llama.removeModelSection(id);
    await writePresetAndReloadRouter(llama, store, modelCache);

    // Removing a section has always left the weights on disk for ever, invisibly -- which is
    // how a 6.7 GB model nobody had configured came to be sitting in the cache. `?weights=1`
    // reclaims them, and it is only safe because the cache is Nelle's.
    const wantsWeights = ctx.query.weights === '1';
    const state = await store.getState();
    // **A repo directory holds every quant of that repo.** Two models on one `repoId` -- two
    // quants, or a duplicate -- share one pile of blobs, so deleting the directory would
    // silently destroy a working model's weights. Not exotic: duplicating a model produces
    // exactly this.
    const sharedWithModelIds = state.models
      .filter(model => removed.repoId != null && model.repoId === removed.repoId)
      .map(model => model.id);

    let reclaimedBytes = 0;
    let weightsRemoved = false;
    if (
      wantsWeights &&
      ownsModelCache() &&
      removed.repoId != null &&
      sharedWithModelIds.length === 0
    ) {
      reclaimedBytes = await removeRepoWeights(paths.modelsDir, removed.repoId);
      weightsRemoved = true;
      // The router's model list is a **startup snapshot** of the cache: without this it keeps
      // offering a model whose weights are gone.
      await llama.getRouterModels({reload: true}).catch(() => undefined);
    }

    return json({
      ok: true,
      removedModelId: id,
      catalog: await modelCatalog(),
      weightsRemoved,
      reclaimedBytes,
      sharedWithModelIds,
    });
  });
}

/**
 * The server knows exactly which keys failed and what each should probably have
 * been, so it says so. One line of red text for a form with ten rows tells a
 * client nothing it can mark, and the next client would have to guess the same
 * way. `error.code` stays a single value for a client that reads only that.
 */
function invalidModelParamsResponse(invalid: InvalidModelParam[]): {
  error: NelleError;
  invalidParams: InvalidModelParam[];
} {
  return {
    error: {
      code: invalidModelParamsCode(invalid),
      message: invalidModelParamsMessage(invalid),
      retryable: false,
    },
    invalidParams: invalid,
  };
}

/**
 * Exported for the Hugging Face import, which is the one other route that mutates the
 * catalog: it adds a section, so the preset has to be rewritten and the router told.
 */
export async function writePresetAndReloadRouter(
  llama: LlamaCppManager,
  store: AppStore,
  modelCache: ModelCacheRepository,
): Promise<void> {
  await llama.writePreset();
  // A removed models.ini section leaves a cache row pointing at a model that no
  // longer exists; the next snapshot would gate attachments on its modalities.
  modelCache.pruneMissingSections((await store.getState()).models.map(model => model.id));
  if ((await llama.getStatus()).running) {
    const result = await llama.getRouterModels({reload: true});
    modelCache.upsertRouterModels(result.models);
  }
}
