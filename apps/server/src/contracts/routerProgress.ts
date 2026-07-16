/**
 * Collapses llama.cpp's model-load progress into one 0..1 fraction of the whole load.
 *
 * A load runs one stage per sub-model -- a vision model loads `text_model` and then
 * `mmproj_model` -- and llama.cpp restarts `value` at 0 for each:
 *
 * ```json
 * {"stages": ["text_model", "mmproj_model"], "current": "text_model",   "value": 0.77}
 * {"stage":  "mmproj_model"}
 * {"stages": ["text_model", "mmproj_model"], "current": "mmproj_model", "value": 0.0}
 * ```
 *
 * So `value` alone is not the load's progress: it fills the bar, snaps back to zero
 * and fills it again. The fraction of the whole load is `(stageIndex + value) /
 * stageCount`, which is monotonic.
 *
 * Returns `undefined` when llama.cpp sent no measurement -- a bare `{"stage": ...}`
 * announces the next stage rather than measuring one, and reading it as 0 would rewind
 * a load that is already reporting. `undefined` means "loading, amount unknown", which
 * a client renders without a number; it never means zero.
 */
export function routerLoadProgress(progress: unknown): number | undefined {
  // Tolerate a bare number, in case a future llama.cpp simplifies the shape.
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    return clampFraction(progress);
  }
  if (typeof progress !== 'object' || progress === null) {
    return undefined;
  }

  const fields = progress as Record<string, unknown>;
  const value = fields.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const stageValue = clampFraction(value);

  const {stages, current} = fields;
  if (!Array.isArray(stages) || stages.length === 0) {
    return stageValue;
  }
  const index = stages.indexOf(current);
  if (index < 0) {
    return stageValue;
  }
  return clampFraction((index + stageValue) / stages.length);
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Reads a llama.cpp `download_progress` SSE frame's `data` into bytes.
 *
 * **A different wire shape from the load-stage frames above, and it must never share their
 * parser.** A download frame's `data` is a map keyed by *URL* -- several files download in
 * parallel (the model, its mmproj, each shard) -- each entry carrying byte counts:
 *
 * ```json
 * {"model":"…","event":"download_progress",
 *  "data":{"https://…model.gguf":{"done":195963406,"total":219307424}}}
 * ```
 *
 * The sums are best-effort: the map holds the files llama.cpp is *currently* fetching, so
 * `totalBytes` is only reported when every entry carried a usable total -- a fraction computed
 * from a partial total would jump around. `undefined` means "downloading, amount unknown",
 * which a client renders without a number; it never means zero.
 *
 * Only routers with the child download relay emit these at all -- the installed b10021 does not
 * (measured: a full 3.6 GB download produced zero frames), which is why the caller must also
 * watch the repo directory on disk. When the frames do arrive, they win: they carry totals.
 */
export function routerDownloadProgress(
  data: unknown,
): {downloadedBytes: number; totalBytes?: number; fraction?: number} | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return undefined;
  }

  let downloaded = 0;
  let total = 0;
  let sawFile = false;
  let everyTotalKnown = true;
  for (const entry of Object.values(data)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const done = (entry as Record<string, unknown>).done;
    if (typeof done !== 'number' || !Number.isFinite(done) || done < 0) {
      continue;
    }
    sawFile = true;
    downloaded += done;
    const fileTotal = (entry as Record<string, unknown>).total;
    if (typeof fileTotal === 'number' && Number.isFinite(fileTotal) && fileTotal > 0) {
      total += fileTotal;
    } else {
      everyTotalKnown = false;
    }
  }
  if (!sawFile) {
    return undefined;
  }
  if (!everyTotalKnown || total <= 0) {
    return {downloadedBytes: downloaded};
  }
  return {
    downloadedBytes: downloaded,
    totalBytes: total,
    fraction: clampFraction(downloaded / total),
  };
}
