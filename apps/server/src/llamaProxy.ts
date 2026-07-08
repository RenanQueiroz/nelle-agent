import type {FastifyInstance} from 'fastify';

import {
  emitCapturedLlamaPerformance,
  mergeChatPerformance,
  performanceFromLlamaPromptProgress,
  performanceFromLlamaTimings,
} from './llamaThroughput';
import type {AppStore} from './store';
import type {ChatPerformance} from './types';

type JsonObject = Record<string, unknown>;

export function registerLlamaProxy(app: FastifyInstance, store: AppStore): void {
  app.post('/api/llama-proxy/v1/chat/completions', async (request, reply) => {
    const state = await store.getState();
    const body = injectTimingOptions(parseJsonObject(request.body));
    const upstream = await fetch(`http://127.0.0.1:${state.runtime.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    });

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!upstream.body) {
      reply.status(upstream.status);
      return reply.send(await upstream.text());
    }

    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await upstream.text();
      observeJsonResponse(text);
      reply.status(upstream.status);
      reply.header('content-type', contentType || 'application/json');
      return reply.send(text);
    }

    reply.raw.writeHead(upstream.status, {
      'content-type': contentType || 'text/event-stream; charset=utf-8',
      'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
      connection: upstream.headers.get('connection') ?? 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const reader = upstream.body.getReader();
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
        reply.raw.write(Buffer.from(value));
      }
    } finally {
      buffer += decoder.decode();
      if (buffer.trim()) {
        observeSseEvent(buffer);
      }
      reply.raw.end();
    }
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
