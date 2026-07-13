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
   * Every llama.cpp key this model's `models.ini` section carries, verbatim. Nelle writes
   * `stop-timeout` into every section itself, so it shows up here and a client must send
   * it back or it silently reverts to the default.
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
