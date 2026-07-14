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
