/**
 * Making a model runnable before a run starts — the state machine, and nothing else.
 *
 * This is the cluster that touches **none** of the manager's private state: no child process, no
 * pid, no install lock. It asks the router to load a model, follows the load, decides whether it
 * worked, and pins the weights when it did. Everything it needs arrives through the constructor,
 * which is what let it leave the manager whole.
 *
 * It talks to llama.cpp only through `LlamaRouterClient` and to `models.ini` only through
 * `writePreset`, so it owns no HTTP and no ini parsing either.
 */

import type {AppPaths} from '../lib/paths';
import type {LlamaRouterModel} from '../lib/types';
import type {AppStore} from '../models/store';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import {routerLoadProgress} from '../contracts/routerProgress.ts';
import {
  MODEL_LOAD_POLL_MS,
  MODEL_LOAD_START_GRACE_MS,
  MODEL_LOAD_TIMEOUT_MS,
  isRunnableRouterStatus,
} from '../contracts/router.ts';
import {writePreset} from './preset.ts';
import type {LlamaRouterClient} from './router.ts';
import {
  delay,
  getProp,
  readSseData,
  routerExitCode,
  safeJsonParse,
  stringOrUndefined,
} from './wire.ts';

export class LlamaModelLoader {
  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly router: LlamaRouterClient,
  ) {}

  /**
   * Makes a model runnable before a run starts, or explains why it cannot be.
   *
   * This state machine used to live in the browser, which meant every client had
   * to reimplement it: post a load, poll `/models`, watch for `failed`, give up
   * after 30 seconds. The semantics are preserved exactly, including the odd one:
   * a model the router does not list at all is left alone, and the request goes
   * through so llama.cpp can answer for itself.
   */
  async ensureModelRunnable(
    modelId: string,
    options: {
      onProgress?: (update: {status: string; progress?: number}) => void;
      timeoutMs?: number;
      pollMs?: number;
    } = {},
  ): Promise<{loaded: boolean}> {
    const pollMs = options.pollMs ?? MODEL_LOAD_POLL_MS;
    const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS) / pollMs));
    const find = (models: LlamaRouterModel[]) => models.find(model => model.sectionId === modelId);

    const current = find((await this.router.getRouterModels()).models);
    if (!current || isRunnableRouterStatus(current.status)) {
      if (current) {
        await this.pinToDownloadedWeights(modelId);
      }
      return {loaded: false};
    }

    // The `/models` list reports a status and never a number: llama.cpp publishes load
    // progress only on `/models/sse`. Without following it, every `model.loading` event
    // reaching a client carries no progress, and the transcript can only say "loading"
    // for the tens of seconds a load takes. Subscribe before asking for the load, so no
    // early frame is missed.
    const progress = this.watchModelLoadProgress(modelId);
    const startedAt = Date.now();
    // Whether the router ever moved the model off `unloaded`. See the dead-child check below:
    // the exit code alone cannot say *which* attempt failed, but "it never even started" can.
    let everStarted = false;
    try {
      if (current.status !== 'loading') {
        await this.router.loadRouterModel(modelId);
      }

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const next = find((await this.router.getRouterModels()).models);
        options.onProgress?.({
          status: next?.status ?? 'unknown',
          progress: progress.latest() ?? next?.progress,
        });
        if (isRunnableRouterStatus(next?.status)) {
          await this.pinToDownloadedWeights(modelId);
          return {loaded: true};
        }
        if (next?.status === 'failed') {
          throw modelLoadError(modelLoadFailureMessage(modelId, next, this.paths.llamaLogPath), {
            logRef: this.paths.llamaLogPath,
          });
        }
        if (next && next.status !== 'unloaded') {
          everStarted = true;
        }
        // **A child that dies at startup is never marked `failed`.** `POST /models/load`
        // answers `{success: true}` -- the router accepted the *request* -- and if the child
        // then exits before it loads a byte (a bad `ctk` value, a preset it will not parse),
        // the router leaves the model at `unloaded` and records the exit code, and nothing
        // else ever happens. Measured: 7s of polling, `unloaded` and `exit_code: 1` on every
        // single tick, no `loading`, no `failed`. Without this the loop grinds out its whole
        // timeout and reports "did not finish loading", when llama.cpp knew the reason
        // instantly and wrote it down.
        //
        // The exit code cannot say *which* attempt it belongs to -- a previous failure leaves
        // the same 1 sitting there -- so it is only trusted once the model has had a grace
        // window to reach `loading` and has not. A real load is `loading` within a second.
        if (
          !everStarted &&
          next?.status === 'unloaded' &&
          Date.now() - startedAt > MODEL_LOAD_START_GRACE_MS
        ) {
          const exitCode = routerExitCode(next.raw);
          if (exitCode != null && exitCode !== 0) {
            throw modelLoadError(modelLoadFailureMessage(modelId, next, this.paths.llamaLogPath), {
              logRef: this.paths.llamaLogPath,
            });
          }
        }
        await delay(pollMs);
      }
      throw modelLoadError(`${modelId} did not finish loading before the router timed out.`);
    } finally {
      progress.close();
    }
  }

  /**
   * Follows llama.cpp's router SSE and keeps the latest load progress for one model.
   *
   * A frame with no measurement in it -- llama.cpp's bare `{"stage": ...}` between
   * stages -- leaves the last number standing rather than erasing it, so the reported
   * progress only ever moves forward. A stream that never opens (llama.cpp busy
   * loading, say) is not an error: the poll loop still governs the wait, and the client
   * simply sees "loading" with no number, which is what it saw before.
   */
  private watchModelLoadProgress(modelId: string): {
    latest: () => number | undefined;
    close: () => void;
  } {
    const abort = new AbortController();
    let latest: number | undefined;

    void (async () => {
      try {
        const response = await this.router.fetchRouterStream('/models/sse', abort.signal);
        if (!response.body) {
          return;
        }
        for await (const data of readSseData(response.body)) {
          const frame = safeJsonParse(data);
          if (stringOrUndefined(getProp(frame, 'model')) !== modelId) {
            continue;
          }
          const value = routerLoadProgress(getProp(getProp(frame, 'data'), 'progress'));
          if (value !== undefined) {
            latest = value;
          }
        }
      } catch {
        // Aborted when the load finished, or llama.cpp closed the stream. Either way the
        // poll loop owns the outcome; this only ever adds a number to it.
      }
    })();

    return {latest: () => latest, close: () => abort.abort()};
  }

  /**
   * A model that has loaded has its weights on disk. Pin it to them.
   *
   * llama.cpp re-resolves `hf-repo` against Hugging Face on **every** load, and its cache
   * fallback fires only when the repo listing comes back *empty*. A deleted or unreachable
   * repo is therefore survivable -- but one that still exists and has merely dropped your
   * quant is not: the listing succeeds, the tag is missing from it, and llama-server exits
   * with `failed to load model ''` while the weights sit intact on disk. Upstream prunes and
   * re-uploads quants routinely, so this is a working model breaking because a stranger
   * edited a repository.
   *
   * A successful load is proof the blobs are complete, and it is the only moment at which
   * pinning is both safe and possible: `offline` also means "never download", so it cannot
   * be a default -- a fresh import would have nothing to fetch with.
   *
   * The preset is written but the router is **not** reloaded: the running instance already
   * holds its resolved args, so a reload would only restart a model that is working. The pin
   * is durable and takes effect from the next load.
   */
  private async pinToDownloadedWeights(modelId: string): Promise<void> {
    const model = await this.store.getModel(modelId);
    if (!model || model.pinned) {
      return;
    }
    await this.store.updateModel(modelId, {pinned: true});
    await writePreset(this.paths, this.store);
  }
}

function modelLoadError(message: string, extra: {logRef?: string} = {}): Error {
  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.modelLoadFailed, retryable: true, ...extra});
  return error;
}

/**
 * Nelle does not guess why a model would not load; llama.cpp already wrote it
 * down. The router reports the child's exit code, and the child's own stderr --
 * the line that actually says what went wrong -- is in the runtime log behind
 * its pid.
 *
 * Removing the context default made this legible-or-useless: a model that loaded
 * yesterday at 16k may not load today at its trained window, and "Check the
 * llama.cpp logs" neither says why nor opens them.
 */
export function modelLoadFailureMessage(
  modelId: string,
  model: {raw?: unknown},
  logPath: string,
): string {
  const exitCode = routerExitCode(model.raw);
  const exit = exitCode == null ? '' : ` (llama-server exited with code ${exitCode})`;
  return (
    `${modelId} failed to load${exit}. The reason is in ${logPath}. ` +
    'A model may not fit its trained context window: set `c` to a smaller size, quantise the KV ' +
    'cache with `ctk`/`ctv`, or move layers with `ngl`, `cmoe` or `ot` in Settings > Models.'
  );
}
