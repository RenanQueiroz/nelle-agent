import {
  emitCapturedLlamaPerformance,
  mergeChatPerformance,
  performanceFromLlamaPromptProgress,
  performanceFromLlamaTimings,
} from './llamaThroughput';
import type {Router} from './http';
import type {AppStore} from './store';
import type {ChatPerformance} from './types';

type JsonObject = Record<string, unknown>;

export function registerLlamaProxy(router: Router, store: AppStore): void {
  router.post('/api/llama-proxy/v1/chat/completions', async ctx => {
    const state = await store.getState();
    const body = injectTimingOptions(parseJsonObject(await ctx.body()));
    // Pi clamps `max_tokens` against its own context estimate before it ever
    // reaches us. Reading it off the wire is the only way to know it did.
    emitCapturedLlamaRequest({maxTokens: numberOrUndefined(body.max_tokens)});

    // `ctx.req.signal` aborts when the browser drops the request, which aborts the
    // upstream llama.cpp fetch -- what `reply.raw.on('close')` used to do.
    let upstream: Response;
    try {
      upstream = await fetch(`http://127.0.0.1:${state.runtime.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: ctx.req.signal,
      });
    } catch (error) {
      if (ctx.req.signal.aborted) {
        return new Response(null, {status: 499});
      }
      throw error;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.body) {
      return new Response(await upstream.text(), {status: upstream.status});
    }

    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await upstream.text();
      observeJsonResponse(text);
      return new Response(text, {
        status: upstream.status,
        headers: {'content-type': contentType || 'application/json'},
      });
    }

    const upstreamBody = upstream.body;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstreamBody.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) {
              break;
            }
            buffer += decoder.decode(value, {stream: true});
            observeSseBuffer(buffer, nextBuffer => {
              buffer = nextBuffer;
            });
            controller.enqueue(value);
          }
        } catch (error) {
          if (!ctx.req.signal.aborted) {
            controller.error(error);
            return;
          }
        } finally {
          buffer += decoder.decode();
          if (buffer.trim()) {
            observeSseEvent(buffer);
          }
          try {
            controller.close();
          } catch {
            // Already errored or closed.
          }
        }
      },
    });

    return new Response(stream, {
      status: upstream.status,
      headers: {
        'content-type': contentType || 'text/event-stream; charset=utf-8',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  });
}

export function localLlamaProxyBaseUrl(): string {
  const port = Number(process.env.NELLE_PORT ?? 8787);
  return `http://127.0.0.1:${port}/api/llama-proxy/v1`;
}

function injectTimingOptions(body: JsonObject): JsonObject {
  if (body.stream === true) {
    return {
      ...body,
      return_progress: true,
      sse_ping_interval: 1,
      timings_per_token: true,
    };
  }
  return body;
}

function parseJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function observeJsonResponse(text: string): void {
  try {
    const parsed = JSON.parse(text) as {timings?: unknown};
    const performance = performanceFromLlamaTimings(parsed.timings);
    if (performance) {
      emitCapturedLlamaPerformance(performance);
    }
  } catch {
    // Timing observation is optional; proxying should not fail because of it.
  }
}

function observeSseBuffer(buffer: string, setBuffer: (buffer: string) => void): void {
  let rest = buffer;
  while (true) {
    const separator = findSseSeparator(rest);
    if (!separator) {
      setBuffer(rest);
      return;
    }
    const event = rest.slice(0, separator.index);
    rest = rest.slice(separator.index + separator.value.length);
    observeSseEvent(event);
  }
}

function findSseSeparator(buffer: string): {index: number; value: string} | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) {
    return null;
  }
  if (lf >= 0 && (crlf < 0 || lf < crlf)) {
    return {index: lf, value: '\n\n'};
  }
  return {index: crlf, value: '\r\n\r\n'};
}

function observeSseEvent(event: string): void {
  const data = event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') {
    return;
  }

  try {
    const parsed = JSON.parse(data) as {prompt_progress?: unknown; timings?: unknown};
    const promptPerformance = performanceFromLlamaPromptProgress(parsed.prompt_progress);
    const timingPerformance = performanceFromLlamaTimings(parsed.timings);
    const performance = mergeOptionalPerformance(promptPerformance, timingPerformance);
    if (performance) {
      emitCapturedLlamaPerformance(performance);
    }
  } catch {
    // Ignore non-JSON SSE payloads; the proxy still relays them unchanged.
  }
}

function mergeOptionalPerformance(
  first: ChatPerformance | null,
  second: ChatPerformance | null,
): ChatPerformance | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return mergeChatPerformance(first, second);
}

type LlamaRequestInfo = {
  /** What Pi asked llama.cpp to generate, after Pi's own context clamp. */
  maxTokens?: number;
};

let activeRequestCapture: ((info: LlamaRequestInfo) => void) | null = null;

/**
 * Observes the requests Pi sends while a run is in flight. Mirrors
 * `beginLlamaPerformanceCapture`: the proxy is the only place these values exist.
 */
export function beginLlamaRequestCapture(onRequest: (info: LlamaRequestInfo) => void): {
  stop(): void;
} {
  const previous = activeRequestCapture;
  activeRequestCapture = onRequest;
  return {
    stop() {
      if (activeRequestCapture === onRequest) {
        activeRequestCapture = previous;
      }
    },
  };
}

export function emitCapturedLlamaRequest(info: LlamaRequestInfo): void {
  activeRequestCapture?.(info);
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
