import type {ChatPerformance, ChatPerformanceMetric} from './types';

type SlotSnapshot = {
  id?: number;
  id_task?: number;
  is_processing?: boolean;
  n_prompt_tokens?: number;
  n_prompt_tokens_processed?: number;
  n_prompt_tokens_cache?: number;
  next_token?: Array<{
    has_next_token?: boolean;
    n_decoded?: number;
  }>;
};

export type ThroughputMonitor = {
  stop(): void;
};

export function startLlamaThroughputMonitor(input: {
  port: number;
  modelId: string;
  onPerformance: (performance: ChatPerformance) => void;
}): ThroughputMonitor {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let activeKey: string | null = null;
  let taskStartTime = 0;
  let generationBaseTokens = 0;
  let generationBaseTime = 0;
  let lastEmittedAt = 0;

  const poll = async () => {
    if (stopped) {
      return;
    }

    try {
      const slot = await fetchProcessingSlot(input.port, input.modelId);
      const decoded = slot?.next_token?.[0]?.n_decoded;
      if (slot && typeof decoded === 'number') {
        const key = `${slot.id ?? 'slot'}:${slot.id_task ?? 'task'}`;
        const now = Date.now();
        if (activeKey !== key) {
          activeKey = key;
          taskStartTime = now;
          generationBaseTokens = decoded;
          generationBaseTime = decoded > 0 ? now : 0;
          lastEmittedAt = 0;
        }

        if (decoded > 0 && generationBaseTime === 0) {
          generationBaseTokens = Math.max(0, decoded - 1);
          generationBaseTime = now;
        }

        const performance = performanceFromSlotSnapshot({
          slot,
          now,
          taskStartTime,
          generationBaseTokens,
          generationBaseTime,
        });
        if (performance && now - lastEmittedAt >= 500) {
          lastEmittedAt = now;
          input.onPerformance(performance);
        }
      }
    } catch {
      // Throughput is optional UI metadata; chat should continue if monitoring fails.
    } finally {
      if (!stopped) {
        timer = setTimeout(poll, 250);
      }
    }
  };

  timer = setTimeout(poll, 250);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

export function performanceFromLlamaTimings(timings: unknown): ChatPerformance | null {
  if (!timings || typeof timings !== 'object') {
    return null;
  }
  const data = timings as {
    cache_n?: unknown;
    prompt_n?: unknown;
    prompt_ms?: unknown;
    prompt_per_second?: unknown;
    predicted_n?: unknown;
    predicted_ms?: unknown;
    predicted_per_second?: unknown;
  };
  const prompt = metricFromTimingFields({
    tokens: data.prompt_n,
    milliseconds: data.prompt_ms,
    tokensPerSecond: data.prompt_per_second,
    cacheTokens: data.cache_n,
  });
  const generation = metricFromTimingFields({
    tokens: data.predicted_n,
    milliseconds: data.predicted_ms,
    tokensPerSecond: data.predicted_per_second,
  });
  if (!prompt && !generation) {
    return null;
  }
  return {
    source: 'llamacpp-timings',
    prompt: prompt ?? undefined,
    generation: generation ?? undefined,
    tokensPerSecond: generation?.tokensPerSecond,
    generatedTokens: generation?.tokens,
  };
}

export function performanceFromLlamaPromptProgress(progress: unknown): ChatPerformance | null {
  if (!progress || typeof progress !== 'object') {
    return null;
  }
  const data = progress as {
    cache?: unknown;
    processed?: unknown;
    time_ms?: unknown;
    total?: unknown;
  };
  const processed = numberOrNull(data.processed);
  const cache = numberOrNull(data.cache) ?? 0;
  const milliseconds = numberOrNull(data.time_ms);
  const total = numberOrNull(data.total);
  if (processed == null || milliseconds == null || milliseconds <= 0) {
    return null;
  }

  const actualTokens = Math.max(0, processed - cache);
  if (actualTokens === 0) {
    return null;
  }

  return {
    source: 'llamacpp-timings',
    prompt: {
      tokens: actualTokens,
      totalTokens: total == null ? undefined : Math.max(0, total),
      cacheTokens: cache,
      milliseconds,
      tokensPerSecond: (actualTokens / milliseconds) * 1000,
    },
  };
}

export function mergeChatPerformance(
  current: ChatPerformance | undefined,
  next: ChatPerformance,
): ChatPerformance {
  if (!current) {
    return next;
  }

  const source =
    current.source === 'llamacpp-timings' || next.source === 'llamacpp-timings'
      ? 'llamacpp-timings'
      : 'llamacpp-slots';
  const merged: ChatPerformance = {
    source,
    prompt: mergeMetric(current.prompt, next.prompt, next.source),
    generation: mergeMetric(current.generation, next.generation, next.source),
  };

  if (merged.generation) {
    merged.tokensPerSecond = merged.generation.tokensPerSecond;
    merged.generatedTokens = merged.generation.tokens;
  } else {
    merged.tokensPerSecond = next.tokensPerSecond ?? current.tokensPerSecond;
    merged.generatedTokens = next.generatedTokens ?? current.generatedTokens;
  }

  return merged;
}

let activeCapture: ((performance: ChatPerformance) => void) | null = null;

export function beginLlamaPerformanceCapture(
  onPerformance: (performance: ChatPerformance) => void,
): {stop(): void} {
  const previous = activeCapture;
  activeCapture = onPerformance;

  return {
    stop() {
      if (activeCapture === onPerformance) {
        activeCapture = previous;
      }
    },
  };
}

export function emitCapturedLlamaPerformance(performance: ChatPerformance): void {
  activeCapture?.(performance);
}

async function fetchProcessingSlot(port: number, modelId: string): Promise<SlotSnapshot | null> {
  const response = await fetch(
    `http://127.0.0.1:${port}/slots?model=${encodeURIComponent(modelId)}`,
  );
  if (!response.ok) {
    return null;
  }
  const slots = (await response.json()) as unknown;
  if (!Array.isArray(slots)) {
    return null;
  }
  return (
    slots.find(slot => {
      const item = slot as SlotSnapshot;
      return item.is_processing === true && typeof item.next_token?.[0]?.n_decoded === 'number';
    }) ?? null
  );
}

function performanceFromSlotSnapshot(input: {
  slot: SlotSnapshot;
  now: number;
  taskStartTime: number;
  generationBaseTokens: number;
  generationBaseTime: number;
}): ChatPerformance | null {
  const prompt = promptMetricFromSlot(input.slot, input.now - input.taskStartTime);
  const decoded = input.slot.next_token?.[0]?.n_decoded;
  const generation =
    typeof decoded === 'number' && input.generationBaseTime > 0
      ? metricFromTimingFields({
          tokens: Math.max(0, decoded - input.generationBaseTokens),
          milliseconds: input.now - input.generationBaseTime,
        })
      : null;

  if (!prompt && !generation) {
    return null;
  }

  return {
    source: 'llamacpp-slots',
    prompt: prompt ?? undefined,
    generation: generation ?? undefined,
    tokensPerSecond: generation?.tokensPerSecond,
    generatedTokens: generation?.tokens,
  };
}

function promptMetricFromSlot(
  slot: SlotSnapshot,
  elapsedMilliseconds: number,
): ChatPerformanceMetric | null {
  const processed = numberOrNull(slot.n_prompt_tokens_processed);
  const cache = numberOrNull(slot.n_prompt_tokens_cache) ?? 0;
  const total = numberOrNull(slot.n_prompt_tokens);
  if (processed == null || elapsedMilliseconds <= 200) {
    return null;
  }

  const actualTokens = Math.max(0, processed - cache);
  if (actualTokens === 0) {
    return null;
  }

  return {
    tokens: actualTokens,
    totalTokens: total == null ? undefined : Math.max(0, total),
    cacheTokens: cache,
    milliseconds: elapsedMilliseconds,
    tokensPerSecond: (actualTokens / elapsedMilliseconds) * 1000,
  };
}

function metricFromTimingFields(input: {
  tokens: unknown;
  milliseconds?: unknown;
  tokensPerSecond?: unknown;
  totalTokens?: unknown;
  cacheTokens?: unknown;
}): ChatPerformanceMetric | null {
  const tokens = numberOrNull(input.tokens);
  const milliseconds = numberOrNull(input.milliseconds);
  const explicitRate = numberOrNull(input.tokensPerSecond);
  if (tokens == null || tokens <= 0) {
    return null;
  }

  const tokensPerSecond =
    explicitRate != null && explicitRate > 0
      ? explicitRate
      : milliseconds != null && milliseconds > 0
        ? (tokens / milliseconds) * 1000
        : null;
  if (tokensPerSecond == null || !Number.isFinite(tokensPerSecond)) {
    return null;
  }

  return {
    tokens,
    tokensPerSecond,
    milliseconds: milliseconds ?? undefined,
    totalTokens: numberOrNull(input.totalTokens) ?? undefined,
    cacheTokens: numberOrNull(input.cacheTokens) ?? undefined,
  };
}

function mergeMetric(
  current: ChatPerformanceMetric | undefined,
  next: ChatPerformanceMetric | undefined,
  nextSource: ChatPerformance['source'],
): ChatPerformanceMetric | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (nextSource === 'llamacpp-slots') {
    return current;
  }
  return next;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}
