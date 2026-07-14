import type {
  ConversationContextUsage,
  ConversationEntryProjection,
} from '../contracts/conversations.ts';
import {conversationContextUsageSchema} from '../contracts/conversations.ts';
import type {ContextUsageStatus} from '../contracts/context.ts';
import {contextUsageStatus, withContextStatus} from '../contracts/context.ts';

/** A JSON column, or `null` when it is absent or unparseable. A bad row is a missing detail. */
function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Context usage: what a conversation has spent of its window, and the live tracker that reports it.
 *
 * **It touches no database and no repository state**, which is why it is here rather than on
 * `ConversationRepository`: it is imported by the Pi harness and by a test, and a caller that only
 * wants to count tokens should not have to drag a SQLite connection along with it.
 *
 * The server **stamps `status`** on every payload it emits, so a client picks a colour rather than
 * recomputing a ratio. `createLiveContextTracker` throttles to one event per
 * `LIVE_CONTEXT_MIN_INTERVAL_MS` — but **never delays a threshold crossing**, because generation
 * grows `usedTokens` by one per token, and an unthrottled tracker would put one event on the wire
 * per generated token.
 */

/**
 * Every context payload leaves the server carrying its `status`, so a client
 * never has to know where the warning threshold sits.
 */
export function buildContextUsage(
  entries: ConversationEntryProjection[],
  totalTokens?: number,
  storedContext?: ConversationContextUsage | null,
): ConversationContextUsage {
  return withContextStatus(resolveContextUsage(entries, totalTokens, storedContext));
}

function resolveContextUsage(
  entries: ConversationEntryProjection[],
  totalTokens?: number,
  storedContext?: ConversationContextUsage | null,
): ConversationContextUsage {
  const totalTokenCount = positiveInteger(totalTokens);
  let derivedContext: ConversationContextUsage | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== 'assistant') {
      continue;
    }
    const context = contextUsageFromPerformance(entry.performance, entry.createdAt);
    if (context) {
      derivedContext = {
        ...context,
        totalTokens: totalTokenCount ?? context.totalTokens,
      };
      break;
    }
  }

  const mergedStored = storedContext
    ? {
        ...storedContext,
        totalTokens: totalTokenCount ?? storedContext.totalTokens,
      }
    : null;
  if (derivedContext && mergedStored) {
    return isContextNewer(mergedStored, derivedContext) ? mergedStored : derivedContext;
  }
  if (derivedContext) {
    return derivedContext;
  }
  if (mergedStored) {
    return mergedStored;
  }
  return {
    totalTokens: totalTokenCount,
  };
}

export function contextUsageFromRow(value: string | null): ConversationContextUsage | null {
  const parsed = parseJson(value);
  const result = conversationContextUsageSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

function isContextNewer(
  candidate: ConversationContextUsage,
  current: ConversationContextUsage,
): boolean {
  const candidateTime = candidate.updatedAt ? Date.parse(candidate.updatedAt) : Number.NaN;
  const currentTime = current.updatedAt ? Date.parse(current.updatedAt) : Number.NaN;
  if (Number.isNaN(candidateTime)) {
    return false;
  }
  if (Number.isNaN(currentTime)) {
    return true;
  }
  return candidateTime >= currentTime;
}

/**
 * Turns each merged performance update into a live context reading.
 *
 * The browser used to do this, which meant it also had to know that
 * `prompt.totalTokens` beats `prompt.tokens` and that generated tokens are added
 * on top. Returns `null` for a tick that would repeat the last token count, so a
 * stream does not carry one `context.updated` per generated token.
 */
export const LIVE_CONTEXT_MIN_INTERVAL_MS = 250;

export function createLiveContextTracker(
  totalTokens: number | undefined,
  options: {minIntervalMs?: number; now?: () => number} = {},
): (performance: unknown) => ConversationContextUsage | null {
  const total = positiveInteger(totalTokens);
  const minIntervalMs = options.minIntervalMs ?? LIVE_CONTEXT_MIN_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  let lastUsedTokens: number | undefined;
  let lastStatus: ContextUsageStatus | undefined;
  let lastEmittedAt: number | undefined;

  return performance => {
    const context = contextUsageFromPerformance(performance, new Date().toISOString());
    if (!context || context.usedTokens === lastUsedTokens) {
      return null;
    }
    const usage = {...context, totalTokens: total};
    const status = contextUsageStatus(usage);
    const at = now();
    // Generation grows `usedTokens` by one per token, so an unthrottled tracker
    // would put a `context.updated` on the wire for every token of a long
    // answer. Crossing a threshold still recolours the bar immediately.
    const throttled =
      lastEmittedAt != null && status === lastStatus && at - lastEmittedAt < minIntervalMs;
    if (throttled) {
      return null;
    }
    lastUsedTokens = usage.usedTokens;
    lastStatus = status;
    lastEmittedAt = at;
    return usage;
  };
}

export function contextUsageFromPerformance(
  performance: unknown,
  updatedAt: string,
): ConversationContextUsage | null {
  if (!performance || typeof performance !== 'object') {
    return null;
  }
  const data = performance as {
    source?: unknown;
    prompt?: unknown;
    generation?: unknown;
    generatedTokens?: unknown;
  };
  const prompt = metricObject(data.prompt);
  const generation = metricObject(data.generation);
  const promptTokens = positiveInteger(prompt?.totalTokens) ?? positiveInteger(prompt?.tokens);
  if (promptTokens == null) {
    return null;
  }
  const generationTokens =
    positiveInteger(generation?.tokens) ?? positiveInteger(data.generatedTokens) ?? 0;

  return {
    usedTokens: promptTokens + generationTokens,
    source: data.source === 'llamacpp-timings' ? 'timings' : 'prompt_progress',
    updatedAt,
  };
}

function metricObject(value: unknown): {
  tokens?: unknown;
  totalTokens?: unknown;
} | null {
  return value && typeof value === 'object' ? value : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}
