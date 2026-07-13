import {z} from 'zod';

import {nelleErrorSchema} from './contracts';
import type {InvalidModelParam} from './modelParams';

/**
 * The `models.ini` catalog: the models Nelle has configured, and the free-form llama.cpp
 * params each is launched with. Served by `GET /api/models`.
 */

/**
 * A model's launch params.
 *
 * **The read and write shapes differ, and it is load-bearing.** `extra` is the free-form
 * key/value map the user edits and the only part a client sends back:
 * `PATCH /api/models/:id` takes `params` as a **flat `Record<string, string>`** which
 * *replaces* `extra` wholesale. So a client that round-trips this object straight back
 * into the PATCH is refused with a 400 -- which is right, but it is not guessable.
 * Edit `params.extra`, send it flat.
 *
 * A full replacement is what makes a key **removable**: an empty object clears the
 * section, which is the only way to take a global context cap back off.
 */
export const modelParamsSchema = z.object({
  /**
   * The context cap the user configured, through `c` here or in `[*]`. **Absent means
   * there is no cap** -- llama.cpp auto-fits from the model's trained window down to the
   * `fitc` floor -- and absent is the normal case.
   *
   * It is a *prediction* of what llama.cpp will do, derived from the params. Once the
   * model has loaded, `/props` is the truth (see `contextWindow` on `LlamaRouterModel`).
   * Read-only: it is computed from `extra`, never sent.
   */
  contextSize: z.number().optional(),
  /**
   * Every llama.cpp key this model's `models.ini` section carries, verbatim -- and
   * **only** what the user put there. Nelle writes no defaults of its own into a section
   * (it used to stamp `stop-timeout = 10`, which is llama.cpp's own default, so it bought
   * nothing and put a mystery row in every editor). A freshly imported model therefore has
   * an empty `extra`, which is the honest answer: it is running on llama.cpp's defaults.
   */
  extra: z.record(z.string(), z.string()),
});

export type ModelParamsContract = z.infer<typeof modelParamsSchema>;

export const configuredModelSchema = z.object({
  /** llama.cpp's **canonical** section id (`…:Q4_K_XL`), and the OpenAI model id. */
  id: z.string(),
  /** The display name; written to `models.ini` as `alias`. Editable. */
  name: z.string(),
  presetName: z.string(),
  /**
   * Free-form, though only `huggingface` exists: a source a newer server invents must not
   * break an older client, exactly as with `LlamaRouterModel.status`.
   */
  source: z.string(),
  repoId: z.string().optional(),
  quant: z.string().optional(),
  /**
   * The **exact** Hugging Face ref (`…:UD-Q4_K_XL`), which is what llama.cpp resolves. It
   * differs from `id`, which uses llama.cpp's canonical quant tag. Never hand-roll either.
   */
  hfRef: z.string().optional(),
  /**
   * **The model is pinned to the weights already on disk** (`offline = 1` in its section),
   * and llama.cpp will not re-resolve the repo when it loads.
   *
   * It has to be able to. llama.cpp re-resolves `hf-repo` against Hugging Face on *every*
   * load, and its cache fallback fires only when the repo listing comes back **empty**. So
   * a deleted, gated or unreachable repo is survivable -- but a repo that still exists and
   * has merely **dropped your quant** (a re-upload, a rename, a prune) is not: the listing
   * succeeds, the tag is not in it, and llama-server dies with `failed to load model ''`
   * while the weights sit intact on disk. Measured, not theorised.
   *
   * So Nelle pins a model the moment it has loaded once -- proof its blobs are complete --
   * and from then on nothing upstream can break it. It cannot be the default: with nothing
   * cached, `offline` also means "never download", so a first import could never fetch
   * anything.
   *
   * Set `pinned: false` to let the next load re-check Hugging Face and pick up an upstream
   * fix (a corrected chat template, a re-quant). It re-pins itself once that load succeeds,
   * so an update is a deliberate act rather than a standing exposure.
   */
  pinned: z.boolean(),
  /**
   * What this model's weights occupy, in bytes. `null` when nothing has been downloaded yet
   * (the weights arrive on the first load), or when the user pointed llama.cpp at a cache of
   * their own -- Nelle will not report on, or delete from, a directory it does not own.
   *
   * **It is the whole repository, and a repository is shared by every quant of it.** Two
   * models on the same `repoId` -- two quants, or a duplicate -- report the same number and
   * share the same bytes. See `DeleteModelResponse.sharedWithModelIds`.
   */
  diskBytes: z.number().nullable(),
  params: modelParamsSchema,
  createdAt: z.string(),
});

export type ConfiguredModelContract = z.infer<typeof configuredModelSchema>;

/**
 * `GET /api/models`, and the answer to **every** catalog mutation.
 *
 * Activating, duplicating and deleting a model all move `activeModelId` -- a duplicate
 * becomes active, and deleting the active model promotes a neighbour -- and editing `[*]`
 * changes the derived `contextSize` of every model at once. So a mutation answers with the
 * whole catalog and a client *applies* it, rather than patching one row and guessing at
 * the rest. (The same rule the conversation routes follow with their snapshot.)
 *
 * This replaced an echo of the server's entire `AppState`, which carried the legacy
 * `chat[]` and the llama.cpp host/port along with it, and which no client ever read.
 */
export const modelCatalogSchema = z.object({
  models: z.array(configuredModelSchema),
  /** The **global default new conversations inherit** -- not what any open chat runs on. */
  activeModelId: z.string().nullable(),
  /** The `[*]` section: applied to every model, overridden by a model's own params. */
  globalModelParams: z.record(z.string(), z.string()),
});

export type ModelCatalogContract = z.infer<typeof modelCatalogSchema>;

/**
 * `DELETE /api/models/:id[?weights=1]`.
 *
 * Deleting a model has always removed its `models.ini` section and left the weights on disk
 * for ever, invisibly -- which is how a 6.7 GB model nobody had configured came to be sitting
 * in the cache. `?weights=1` reclaims them, and that is only safe because the cache is Nelle's.
 */
export const deleteModelResponseSchema = z.object({
  ok: z.boolean(),
  removedModelId: z.string(),
  catalog: modelCatalogSchema,
  weightsRemoved: z.boolean(),
  /** Bytes reclaimed. `0` unless [weightsRemoved]. */
  reclaimedBytes: z.number(),
  /**
   * Other configured models that share this repository -- **the weights were kept because of
   * them**, even though `?weights=1` was asked for.
   *
   * A Hugging Face repo directory holds *every* quant of that repo, so two models on the same
   * `repoId` share one pile of blobs. That is not exotic: duplicating a model produces exactly
   * this, and so does importing a second quant. Deleting the directory would silently destroy
   * a working model's weights.
   */
  sharedWithModelIds: z.array(z.string()),
});

export type DeleteModelResponse = z.infer<typeof deleteModelResponseSchema>;

/**
 * One rejected `models.ini` key, from a 400 on `PATCH /api/models/:id` or
 * `/api/models/global-params`.
 *
 * A client joins these to its rows **by `key`, never by row id**, so a row stops being
 * marked the moment its key changes and editing one row cannot unmark another.
 */
export const invalidModelParamSchema = z.object({
  key: z.string(),
  reason: z.enum(['unknown', 'reserved', 'duplicate', 'syntax']),
  message: z.string(),
  /** The nearest real key, when one is close enough to be worth offering as a one-tap fix. */
  suggestion: z.string().optional(),
}) satisfies z.ZodType<InvalidModelParam>;

/**
 * The 400 body itself. `error.code` is a single value for a client that reads only that;
 * `invalidParams` names **every** bad key at once, because a form with three typos should
 * light up three rows on one save rather than on three.
 */
export const invalidModelParamsResponseSchema = z.object({
  error: nelleErrorSchema,
  invalidParams: z.array(invalidModelParamSchema),
});

export type InvalidModelParamsResponse = z.infer<typeof invalidModelParamsResponseSchema>;
