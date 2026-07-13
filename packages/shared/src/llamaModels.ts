import {z} from 'zod';

/**
 * llama.cpp's live view of one `models.ini` section, as served by
 * `GET /api/llama/models`.
 */
export const llamaRouterModelSchema = z.object({
  sectionId: z.string(),
  routerModelId: z.string().optional(),
  alias: z.string(),
  hfRepo: z.string().optional(),
  /**
   * llama.cpp's own word for the model's state (`unloaded`, `loading`, `loaded`,
   * `sleeping`, ...). Deliberately a free-form string, never an enum: a status a
   * newer llama.cpp invents must not break a client that only renders it.
   */
  status: z.string(),
  /** 0..1 while the weights load. */
  progress: z.number().optional(),
  aliases: z.array(z.string()),
  source: z.string().optional(),
  canRemove: z.boolean().optional(),
  architecture: z.string().optional(),
  /**
   * How this model's last child process ended, when the router has one to report.
   *
   * **`unloaded` with a nonzero `exitCode` is a model whose last load FAILED**, and it is the
   * only way to know: llama.cpp answers `{success: true}` to a load (it accepted the request),
   * and a child that then dies before it loads a byte -- a bad `ctk` value, a preset it will not
   * parse -- leaves the model sitting at `unloaded`, never `failed`. Render it, or a Load button
   * that failed looks exactly like one that did nothing at all. The reason itself is in the
   * llama.cpp log; Nelle does not guess at it.
   */
  exitCode: z.number().optional(),
  /** llama.cpp's `/props` answer: the window a conversation on it actually gets. */
  contextWindow: z.number().optional(),
  /** `n_ctx_train`: the window the model was trained for. Absent until loaded once. */
  contextTrain: z.number().optional(),
  /** From the GGUF header of the blob llama.cpp loaded. */
  parameterCount: z.number().optional(),
});

export type LlamaRouterModelContract = z.infer<typeof llamaRouterModelSchema>;

/**
 * `GET /api/llama/models`.
 *
 * `raw` is deliberately absent from the contract. It is llama.cpp's opaque blob and
 * it is a *fresh object on every response*, so a client that holds it rebuilds its
 * UI when nothing it renders has changed. The server still sends it -- the contract
 * simply does not promise it, and the generated client never sees it.
 */
export const llamaModelsResponseSchema = z.object({
  models: z.array(llamaRouterModelSchema),
});

export type LlamaModelsResponse = z.infer<typeof llamaModelsResponseSchema>;
