import {z} from 'zod';

/**
 * `GET /api/huggingface/search?q=` -- browsing Hugging Face for a GGUF to import.
 *
 * Everything here is Hugging Face's, reshaped: the metadata comes from the `gguf` block
 * the list endpoint already returns, and the file sizes from a `?blobs=true` request per
 * repo. It is a network call and it takes seconds.
 */

export const huggingFaceFileSchema = z.object({
  filename: z.string(),
  /** `null` when Hugging Face did not report one. */
  size: z.number().nullable(),
});

/**
 * One quantization on offer, and the file (or **files**) it is made of.
 *
 * Only files llama.cpp itself would accept as a model appear here: `mmproj`, `imatrix` and
 * `mtp-` files are its *accessories*, downloaded alongside whatever model you chose, and
 * offering one as a quant offers the accessory instead of the thing.
 */
export const huggingFaceQuantSchema = z.object({
  quant: z.string(),
  /**
   * The sum of the quant's files, or `null` when any size is unknown. **More than one file
   * is normal**: a large quant is split (`…-00001-of-00002.gguf`) and llama.cpp downloads
   * every shard.
   */
  size: z.number().nullable(),
  files: z.array(huggingFaceFileSchema),
});

export const huggingFaceModelResultSchema = z.object({
  /** The repo id, `owner/name`. This plus a `quant` is what `POST /api/huggingface/use` takes. */
  id: z.string(),
  author: z.string().optional(),
  downloads: z.number().optional(),
  likes: z.number().optional(),
  tags: z.array(z.string()),
  /** From Hugging Face's own parse of the GGUF header -- free, on a request Nelle already makes. */
  architecture: z.string().optional(),
  parameterCount: z.number().optional(),
  /** The trained context window, known *before* the model has ever been loaded. */
  contextTrain: z.number().optional(),
  files: z.array(huggingFaceFileSchema),
  quants: z.array(huggingFaceQuantSchema),
});

export type HuggingFaceModelResultContract = z.infer<typeof huggingFaceModelResultSchema>;

export const huggingFaceSearchResponseSchema = z.object({
  results: z.array(huggingFaceModelResultSchema),
});

export type HuggingFaceSearchResponse = z.infer<typeof huggingFaceSearchResponseSchema>;
