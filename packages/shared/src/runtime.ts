import {z} from 'zod';

import type {LlamaOptionCatalogue} from './modelParams';

/**
 * The llama.cpp runtime: what is installed, whether it is running, and how it will be
 * launched. Served by `GET /api/runtime`, and embedded in `GET /api/llama/props`.
 */

/**
 * How the binary got here.
 *
 * `external` means `LLAMA_SERVER_PATH` points at a binary Nelle does not own -- install
 * and update are then no-ops that only report status. Otherwise Linux builds from source
 * (a `git clone` plus a full cmake build: **minutes**, not seconds) and everything else
 * takes a GitHub release.
 */
export const runtimeInstallModeSchema = z.enum(['source-master', 'github-release', 'external']);

export const runtimeStatusSchema = z.object({
  platform: z.string(),
  arch: z.string(),
  dataDir: z.string(),
  /** `null` when nothing is installed. */
  binaryPath: z.string().nullable(),
  logPath: z.string(),
  installMode: runtimeInstallModeSchema,
  installed: z.boolean(),
  /**
   * A **git sha** on Linux (it builds from master) and a release tag elsewhere. Do not
   * render it as a version number.
   */
  installedVersion: z.string().nullable(),
  /** Only fetched when the caller asks for it: `GET /api/runtime?latest=1` costs a GitHub round trip. */
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean(),
  running: z.boolean(),
  /** The managed llama-server's pid, or `null` when Nelle did not start it. */
  pid: z.number().nullable(),
  host: z.string(),
  port: z.number(),
  /**
   * The launch limits, read from the `runtime` **settings group** -- `GET /api/runtime`
   * only *reports* them. They are written through `PATCH /api/settings/runtime`, and a
   * change needs a llama.cpp restart. A client must not grow a second editor for them:
   * they already render from the served settings schema like every other group.
   */
  modelsMax: z.number(),
  sleepIdleSeconds: z.number(),
  activeModelId: z.string().nullable(),
  /** Why the last start or install failed. Sticky until the next attempt succeeds. */
  lastError: z.string().nullable(),
});

export type RuntimeStatusContract = z.infer<typeof runtimeStatusSchema>;

/**
 * `GET /api/llama/props` -- llama.cpp's router, plus the runtime that launched it.
 *
 * `raw` is deliberately absent, as it is on `LlamaRouterModel`: it is llama.cpp's opaque
 * blob, and the contract does not promise it.
 */
export const llamaRouterPropsSchema = z.object({
  role: z.string().nullable(),
  /** `--models-max`: how many models the router will hold at once. */
  maxInstances: z.number().nullable(),
  modelsAutoload: z.boolean().nullable(),
  runtime: runtimeStatusSchema,
});

export type LlamaRouterPropsContract = z.infer<typeof llamaRouterPropsSchema>;

/**
 * `GET /api/runtime/logs` -- a tail of llama-server's log, as one string.
 *
 * There is no log *stream*: this is a one-shot read of the last `maxBytes` (default
 * 80,000, clamped to 1,000,000), so a client that wants live output polls it.
 */
export const runtimeLogTailSchema = z.object({
  path: z.string(),
  text: z.string(),
});

export type RuntimeLogTail = z.infer<typeof runtimeLogTailSchema>;

/** `POST /api/llama/tokenize`. `raw` is llama.cpp's blob and stays off the contract. */
export const llamaTokenizeResultSchema = z.object({
  tokens: z.number(),
});

export type LlamaTokenizeResultContract = z.infer<typeof llamaTokenizeResultSchema>;

/**
 * One `llama-server --help` option, as parsed by `LlamaOptionCatalogueCache` and served by
 * `GET /api/llama/params`.
 */
export const llamaOptionSchema = z.object({
  /** Every argument spelling with its leading dashes stripped: `['c', 'ctx-size']`. */
  keys: z.array(z.string()),
  /** Environment variable names, which a preset accepts as keys too. */
  env: z.array(z.string()),
  /** `N`, `<0|1>`, `START END`. Absent for a flag such as `--swa-full`. */
  valueHint: z.string().optional(),
  help: z.string(),
  section: z.string(),
});

/**
 * `GET /api/llama/params` -- what a `models.ini` key is validated against.
 *
 * The catalogue comes from the **binary**, never from a list Nelle carries, so it moves
 * when llama.cpp is upgraded. `available: false` means no binary, or a `--help` output
 * Nelle could not parse -- and then the unknown-key check is **skipped**, because refusing
 * to save a parameter because Nelle could not run a binary is worse than the typo.
 *
 * A client renders this for completion and hints. It must **not** validate against it:
 * that is the server's job (and, underneath, llama-server's), and a second copy of the
 * rule is how it goes stale.
 */
export const llamaOptionCatalogueSchema = z.object({
  available: z.boolean(),
  options: z.array(llamaOptionSchema),
  // Pinned against the parser's own output type (`modelParams.ts`, which stays zod-free so
  // the web bundle can import it): if the `--help` parser grows a field, the served schema
  // fails to compile rather than quietly omitting it from the contract.
}) satisfies z.ZodType<LlamaOptionCatalogue>;

export type LlamaOptionCatalogueContract = z.infer<typeof llamaOptionCatalogueSchema>;
