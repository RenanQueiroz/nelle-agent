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
import {routerDownloadProgress, routerLoadProgress} from '../contracts/routerProgress.ts';
import {
  MODEL_LOAD_ABSOLUTE_MAX_MS,
  MODEL_LOAD_POLL_MS,
  MODEL_LOAD_STALL_MS,
  MODEL_LOAD_START_GRACE_MS,
  isRunnableRouterStatus,
} from '../contracts/router.ts';
import {writePreset} from './preset.ts';
import type {LlamaRouterClient} from './router.ts';
import {repoDiskBytes} from './weights.ts';
import {
  delay,
  getProp,
  readSseData,
  routerExitCode,
  safeJsonParse,
  stringOrUndefined,
} from './wire.ts';

/** What the wait reports while it works: the status, and whichever numbers exist yet. */
export type ModelLoadProgressUpdate = {
  status: string;
  /** 0..1 of the current phase — download fraction while downloading (only when the router
   *  reported totals), load-stage fraction while loading. Absent means "working, amount
   *  unknown", never zero. */
  progress?: number;
  /** Set once there is evidence of which phase this is; absent on the first quiet ticks. */
  phase?: 'downloading' | 'loading';
  downloadedBytes?: number;
  totalBytes?: number;
};

export type EnsureModelRunnableOptions = {
  onProgress?: (update: ModelLoadProgressUpdate) => void;
  pollMs?: number;
  stallMs?: number;
  absoluteMaxMs?: number;
};

export class LlamaModelLoader {
  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly router: LlamaRouterClient,
  ) {}

  /**
   * Makes a model runnable before a run starts, or explains why it cannot be.
   *
   * The wait is bounded by a **stall window, not a wall clock**. A first load *downloads* the
   * weights — multi-GB, minutes on an ordinary connection — and the old fixed 30s deadline
   * failed every such load while it was quietly succeeding (reproduced live: `model_load_failed`
   * at 30.0s, model ready at 33s). So the deadline resets on evidence of progress, any of:
   *
   * - the model's **repo directory growing on disk** — the one signal every llama.cpp build
   *   gives, because blobs download in place (the installed b10021 emits no download SSE at
   *   all, measured across a full 3.6 GB download);
   * - an SSE frame for this model arriving — status flips, load stages, and on newer routers
   *   `download_progress` frames with real byte counts;
   * - the router status changing (`unloaded` → `loading`/`downloading` → …). Statuses this
   *   build has never seen — master already adds `downloading` — count as in-progress, never
   *   as failure.
   *
   * A genuinely wedged load therefore still dies in ~`MODEL_LOAD_STALL_MS`, while a slow
   * download runs to completion, with `MODEL_LOAD_ABSOLUTE_MAX_MS` as the backstop against a
   * download that trickles forever. The dead-child fast-fail (below) is untouched: a child that
   * exits at startup fails in seconds, on the exit code, not by outlasting any window.
   */
  async ensureModelRunnable(
    modelId: string,
    options: EnsureModelRunnableOptions = {},
  ): Promise<{loaded: boolean}> {
    const pollMs = options.pollMs ?? MODEL_LOAD_POLL_MS;
    const stallMs = options.stallMs ?? MODEL_LOAD_STALL_MS;
    const absoluteMaxMs = options.absoluteMaxMs ?? MODEL_LOAD_ABSOLUTE_MAX_MS;
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
    const watcher = this.watchModelLoadProgress(modelId);
    const startedAt = Date.now();
    // The repo directory is the download's only build-independent progress signal (see above).
    // `repoId` is null for a model without one, and `repoDiskBytes` is null until the first
    // byte lands — both simply mean "no signal from disk", not zero.
    const repoId = (await this.store.getModel(modelId))?.repoId ?? null;
    let dirBytes = repoId ? await repoDiskBytes(this.paths.modelsDir, repoId) : null;
    let sawDownloadGrowth = false;
    let lastProgressAt = startedAt;
    let lastStatus: string | undefined = current.status;
    let lastFrameAt = 0;
    // Whether the router ever moved the model off `unloaded`. See the dead-child check below:
    // the exit code alone cannot say *which* attempt failed, but "it never even started" can.
    let everStarted = false;
    try {
      if (current.status !== 'loading' && current.status !== 'downloading') {
        await this.router.loadRouterModel(modelId);
      }

      for (;;) {
        const next = find((await this.router.getRouterModels()).models);

        // -- Progress detection: each signal advances the stall deadline. --
        if (repoId) {
          const measured = await repoDiskBytes(this.paths.modelsDir, repoId);
          if (measured != null && measured > (dirBytes ?? 0)) {
            dirBytes = measured;
            sawDownloadGrowth = true;
            lastProgressAt = Date.now();
          }
        }
        if (watcher.lastFrameAt() > lastFrameAt) {
          lastFrameAt = watcher.lastFrameAt();
          lastProgressAt = Date.now();
        }
        if (next?.status !== lastStatus) {
          lastStatus = next?.status;
          lastProgressAt = Date.now();
        }

        // -- What to tell the client. Download numbers prefer the SSE frames (they carry
        // totals); the disk measurement stands in on routers that never emit them. --
        const download = watcher.download();
        const stage = watcher.latest() ?? next?.progress;
        const phase: ModelLoadProgressUpdate['phase'] =
          stage !== undefined || isRunnableRouterStatus(next?.status)
            ? 'loading'
            : download !== undefined || sawDownloadGrowth
              ? 'downloading'
              : undefined;
        options.onProgress?.({
          status: next?.status ?? 'unknown',
          progress: phase === 'downloading' ? download?.fraction : stage,
          phase,
          downloadedBytes:
            phase === 'downloading'
              ? (download?.downloadedBytes ?? dirBytes ?? undefined)
              : undefined,
          totalBytes: phase === 'downloading' ? download?.totalBytes : undefined,
        });

        if (isRunnableRouterStatus(next?.status)) {
          await this.pinToDownloadedWeights(modelId);
          return {loaded: true};
        }
        if (next?.status === 'failed' || watcher.downloadFailed()) {
          throw modelLoadError(
            modelLoadFailureMessage(modelId, next ?? {}, this.paths.llamaLogPath),
            {logRef: this.paths.llamaLogPath},
          );
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
        // stall window and reports "did not finish loading", when llama.cpp knew the reason
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
        if (Date.now() - lastProgressAt > stallMs) {
          throw modelLoadError(
            `${modelId} did not finish loading: no download or load progress for ` +
              `${Math.round(stallMs / 1000)}s.`,
            {logRef: this.paths.llamaLogPath},
          );
        }
        if (Date.now() - startedAt > absoluteMaxMs) {
          throw modelLoadError(
            `${modelId} did not finish loading within ` +
              `${Math.round(absoluteMaxMs / 60_000)} minutes.`,
            {logRef: this.paths.llamaLogPath},
          );
        }
        await delay(pollMs);
      }
    } finally {
      watcher.close();
    }
  }

  /**
   * Follows llama.cpp's router SSE and keeps the latest progress for one model.
   *
   * Two different frame shapes travel this stream and each gets its own parser: load-stage
   * frames (`data.progress`, collapsed by `routerLoadProgress`) and — on routers new enough to
   * relay the child's downloader — `download_progress` frames (`data` is a per-URL byte map,
   * read by `routerDownloadProgress`). A frame with no measurement in it leaves the last
   * numbers standing, so the reported progress only ever moves forward; the subscribe-time
   * snapshot arrives as `event:"model_status"` rather than `status_change`, which is why
   * nothing here filters on the event name except the two download events.
   *
   * `lastFrameAt` records when *any* frame for this model arrived — the stall deadline treats
   * that as a heartbeat. A stream that never opens (llama.cpp busy loading, say) is not an
   * error: the poll loop still governs the wait, and the client simply sees "loading" with no
   * number, which is what it saw before.
   */
  private watchModelLoadProgress(modelId: string): {
    latest: () => number | undefined;
    download: () => {downloadedBytes: number; totalBytes?: number; fraction?: number} | undefined;
    downloadFailed: () => boolean;
    lastFrameAt: () => number;
    close: () => void;
  } {
    const abort = new AbortController();
    let latest: number | undefined;
    let download: {downloadedBytes: number; totalBytes?: number; fraction?: number} | undefined;
    let downloadFailed = false;
    let lastFrameAt = 0;

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
          lastFrameAt = Date.now();
          const event = stringOrUndefined(getProp(frame, 'event'));
          if (event === 'download_progress') {
            const parsed = routerDownloadProgress(getProp(frame, 'data'));
            if (parsed !== undefined) {
              download = parsed;
            }
            continue;
          }
          if (event === 'download_failed') {
            downloadFailed = true;
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

    return {
      latest: () => latest,
      download: () => download,
      downloadFailed: () => downloadFailed,
      lastFrameAt: () => lastFrameAt,
      close: () => abort.abort(),
    };
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
