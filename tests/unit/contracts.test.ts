import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {normalizeNelleError} from '../../apps/server/src/errors.ts';
import {
  createEventEnvelope,
  eventEnvelopeSchema,
  nelleErrorSchema,
  serializeSseEnvelope,
  NELLE_ERROR_CODES,
} from '../../packages/shared/src/contracts.ts';

test('Nelle error schema accepts stable error payloads', () => {
  const parsed = nelleErrorSchema.parse({
    code: 'conversation_busy',
    message: 'This conversation already has an active run.',
    retryable: true,
    logRef: 'logs/app.log:120',
  });

  assert.equal(parsed.code, 'conversation_busy');
});

test('event envelopes serialize as SSE with matching id and event type', () => {
  const envelope = createEventEnvelope({
    id: 'event-1',
    type: 'run.started',
    conversationId: 'conversation-1',
    runId: 'run-1',
    createdAt: '2026-07-08T12:00:00.000Z',
    data: {kind: 'chat', modelId: 'repo/model:Q4_K_M'},
  });

  assert.equal(eventEnvelopeSchema.parse(envelope).type, 'run.started');
  assert.equal(
    serializeSseEnvelope(envelope),
    `id: event-1\nevent: run.started\ndata: ${JSON.stringify(envelope)}\n\n`,
  );
});

test('generated event ids are monotonic within one process', () => {
  const first = createEventEnvelope({type: 'a', data: {}}).id;
  const second = createEventEnvelope({type: 'a', data: {}}).id;

  assert.ok(first <= second);
});

test('llama.cpp context overflow is recognised wherever it surfaces', () => {
  // The exact payload `server_task_result_error::to_json` produces for
  // ERROR_TYPE_EXCEED_CONTEXT_SIZE, as Pi rethrows it.
  const upstream = JSON.stringify({
    error: {
      code: 400,
      message:
        'request (20000 tokens) exceeds the available context size (16384 tokens), try increasing it',
      type: 'exceed_context_size_error',
      n_prompt_tokens: 20000,
      n_ctx: 16384,
    },
  });

  const mapped = normalizeNelleError(new Error(`HTTP 400: ${upstream}`));
  assert.equal(mapped.code, 'context_overflow');
  assert.equal(mapped.retryable, false);
  assert.match(mapped.message, /longer than the model’s context window/);
  assert.match(mapped.message, /20,000 tokens/);
  assert.match(mapped.message, /16,384/);
  assert.match(mapped.message, /\/compact/);

  // An in-stream error chunk carries the same object, so the same match holds.
  const chunk = normalizeNelleError(new Error(`stream error: ${upstream}`));
  assert.equal(chunk.code, 'context_overflow');

  // An ordinary failure keeps its fallback code.
  const other = normalizeNelleError(new Error('boom'), {fallbackCode: 'pi_run_failed'});
  assert.equal(other.code, 'pi_run_failed');
});

test('every emitted error code is in the shared code set', () => {
  const codes = new Set<string>(Object.values(NELLE_ERROR_CODES));
  for (const code of [
    'conversation_busy',
    'session_unavailable',
    'context_overflow',
    'llama_server_stopped',
    'model_load_failed',
    'unsupported_attachment',
    'unsupported_slash_command',
    'tools_disabled',
    'archive_session_missing',
  ]) {
    assert.ok(codes.has(code), `${code} is missing from NELLE_ERROR_CODES`);
  }
});
