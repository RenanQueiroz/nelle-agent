import type {ChatPerformance} from './types';

type SlotSnapshot = {
  id?: number;
  id_task?: number;
  is_processing?: boolean;
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
  let baseTokens = 0;
  let baseTime = 0;
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
          baseTokens = decoded;
          baseTime = now;
          lastEmittedAt = 0;
        }

        const generatedTokens = Math.max(0, decoded - baseTokens);
        const elapsedSeconds = (now - baseTime) / 1000;
        if (generatedTokens > 0 && elapsedSeconds > 0.2 && now - lastEmittedAt >= 500) {
          lastEmittedAt = now;
          input.onPerformance({
            tokensPerSecond: generatedTokens / elapsedSeconds,
            source: 'llamacpp-slots',
            generatedTokens,
          });
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
  const data = timings as {predicted_per_second?: unknown; predicted_n?: unknown};
  if (
    typeof data.predicted_per_second !== 'number' ||
    !Number.isFinite(data.predicted_per_second)
  ) {
    return null;
  }
  return {
    tokensPerSecond: data.predicted_per_second,
    source: 'llamacpp-timings',
    generatedTokens: typeof data.predicted_n === 'number' ? data.predicted_n : undefined,
  };
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
