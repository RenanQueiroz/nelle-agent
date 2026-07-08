import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEventEnvelope,
  eventEnvelopeSchema,
  nelleErrorSchema,
  serializeSseEnvelope,
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
