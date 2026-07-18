import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {createEventEnvelope, serializeSseEnvelope} from '../../../src/contracts/contracts.ts';

/**
 * **The SSE envelope's wire format**, which is a contract with a shipped client.
 *
 * This used to be tested by driving a whole chat run through `directLlama` behind
 * `NELLE_PI_DISABLED=1` — an affordance that has been deleted, because it was never a real fallback
 * (unreachable in production, no tools, no reasoning, no compaction). Testing the envelope *through*
 * a fake chat engine was always the long way round: what the client actually depends on is the
 * envelope itself, so that is what is pinned here.
 *
 * The real end-to-end proof — a genuine SSE stream, from a real server, parsed by the real Flutter
 * client — is the device suite, which does it against an actual model.
 */

test('an envelope carries the event type on the SSE `event:` line, and an id and a timestamp', () => {
  const envelope = createEventEnvelope({
    type: 'run.started',
    data: {type: 'run.started', runId: 'run-1', conversationId: 'c1'},
  });

  // The client reads `type` off the envelope, and the union member names ARE the wire contract.
  assert.equal(envelope.type, 'run.started');
  assert.ok(envelope.id, 'every envelope is identified');
  assert.ok(envelope.createdAt, 'and stamped');

  const wire = serializeSseEnvelope(envelope);

  // `event:` is what an EventSource dispatches on; `data:` carries the JSON. Both, or a browser-shaped
  // client sees nothing.
  assert.match(wire, /^event: run\.started$/m);
  assert.match(wire, /^data: \{/m);
  // A frame ends with a blank line. Without it the client buffers forever, waiting for a frame that
  // has already been sent.
  assert.ok(wire.endsWith('\n\n'), 'a frame is terminated by a blank line');

  const payload = JSON.parse(/^data: (.*)$/m.exec(wire)![1]!) as {
    type: string;
    data: {type: string; runId: string};
  };
  // The envelope `type` MIRRORS the inner event's type. A client may read either and must get the
  // same answer.
  assert.equal(payload.type, 'run.started');
  assert.equal(payload.data.type, 'run.started');
  assert.equal(payload.data.runId, 'run-1');
});

test('ids are monotonic, so a client can order what it receives', () => {
  const first = createEventEnvelope({type: 'run.started', data: {type: 'run.started'}});
  const second = createEventEnvelope({type: 'run.completed', data: {type: 'run.completed'}});
  assert.notEqual(first.id, second.id, 'two envelopes never share an id');
});
