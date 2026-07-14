import {createEventEnvelope, serializeSseEnvelope} from '../contracts/contracts.ts';
import type {ChatStreamEvent} from '../lib/types';
import {createErrorEvent} from './errors';

/**
 * Server-sent events, and the envelope every stream route writes into one.
 *
 * The sink is `{write}` -- the shape `reply.raw` had under Fastify, which is why the stream
 * writers did not have to change when the router did.
 */

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

/**
 * Runs an SSE producer against a `{write}` sink backed by a `ReadableStream`
 * controller -- the same sink shape `reply.raw` gave the stream writers, so they
 * are unchanged.
 */
export function sseResponse(
  run: (sink: {write: (chunk: string) => void}) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = {write: (chunk: string) => controller.enqueue(encoder.encode(chunk))};
      try {
        await run(sink);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (e.g. the client went away).
        }
      }
    },
  });
  return new Response(stream, {status: 200, headers: SSE_HEADERS});
}

export async function writeChatStream(
  raw: {write: (chunk: string) => void},
  stream: AsyncIterable<ChatStreamEvent>,
  conversationId: string,
): Promise<void> {
  for await (const event of stream) {
    writeChatEvent(raw, event, conversationId);
  }
}

export function writeChatEvent(
  raw: {write: (chunk: string) => void},
  event: ChatStreamEvent,
  conversationId: string,
): void {
  raw.write(
    serializeSseEnvelope(
      createEventEnvelope({
        type: event.type,
        conversationId: eventConversationId(event, conversationId),
        runId: eventRunId(event),
        data: event,
      }),
    ),
  );
}

export function writeChatError(raw: {write: (chunk: string) => void}, error: unknown): void {
  const event: ChatStreamEvent = createErrorEvent(error, {fallbackCode: 'stream_failed'});
  raw.write(
    serializeSseEnvelope(
      createEventEnvelope({
        type: event.type,
        data: event,
      }),
    ),
  );
}

function eventConversationId(event: ChatStreamEvent, fallback: string): string {
  if ('conversationId' in event && typeof event.conversationId === 'string') {
    return event.conversationId;
  }
  return fallback;
}

function eventRunId(event: ChatStreamEvent): string | undefined {
  if ('runId' in event && typeof event.runId === 'string') {
    return event.runId;
  }
  return undefined;
}
