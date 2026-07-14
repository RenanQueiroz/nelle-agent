import assert from 'node:assert/strict';
import {describe, test} from 'bun:test';

import {createAsyncQueue} from '../../../apps/server/src/lib/asyncQueue.ts';
import type {ChatStreamEvent, ToolCallEvent} from '../../../apps/server/src/lib/types.ts';
import type {HostToolRepository} from '../../../apps/server/src/pi/hostTools.ts';
import {createToolEventSubscriber} from '../../../apps/server/src/pi/tools.ts';

/**
 * The fail-closed gate on host tools, end to end through the subscriber.
 *
 * `tools: []` at session construction is a *build-time* gate. A cached Pi session, a Pi retry, or a
 * user flipping host tools off mid-run can each land a tool event on this subscriber anyway, and an
 * unsandboxed shell is what is on the other side of it. Until now only the pieces were tested
 * (`isToolExecutionEvent`, `createErrorEvent(new ToolsDisabledError())`); nothing pinned the
 * behaviour they combine into, which is the behaviour that matters.
 */

type Recorded = {starts: unknown[]; ends: unknown[]};

function fakeHostTools(enabled: boolean, recorded: Recorded): HostToolRepository {
  return {
    areToolsEnabled: () => enabled,
    recordToolStart: (input: unknown) => void recorded.starts.push(input),
    recordToolEnd: (input: unknown) => void recorded.ends.push(input),
  } as unknown as HostToolRepository;
}

function harness(enabled: boolean) {
  const recorded: Recorded = {starts: [], ends: []};
  const queue = createAsyncQueue<ChatStreamEvent>();
  const emitted: ChatStreamEvent[] = [];
  const originalPush = queue.push.bind(queue);
  queue.push = (event: ChatStreamEvent) => {
    emitted.push(event);
    originalPush(event);
  };

  const toolCalls: ToolCallEvent[] = [];
  let aborts = 0;

  const subscriber = createToolEventSubscriber({
    hostTools: fakeHostTools(enabled, recorded),
    conversationId: 'conv-1',
    queue,
    toolCalls,
    abortRun: () => {
      aborts += 1;
    },
  });

  return {subscriber, recorded, emitted, toolCalls, aborts: () => aborts};
}

describe('host tools fail closed at runtime', () => {
  test('a tool event with tools disabled writes no audit row and emits no tool_call.updated', () => {
    const h = harness(false);

    const handled = h.subscriber({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: {command: 'rm -rf /'},
    });

    // The subscriber still *claims* the event, so the caller's own message_update
    // handling never sees a tool event it would treat as prose.
    assert.equal(handled, true);

    assert.deepEqual(h.recorded.starts, [], 'no audit row may be written');
    assert.deepEqual(h.recorded.ends, [], 'no audit row may be written');
    assert.deepEqual(h.toolCalls, [], 'the run must not collect the call');
    assert.equal(
      h.emitted.some(event => event.type === 'tool_call.updated'),
      false,
      'no tool_call.updated may reach the client',
    );

    const error = h.emitted.find(event => event.type === 'error');
    assert.ok(error, 'the run must be told why it stopped');
    assert.equal((error as {code: string}).code, 'tools_disabled');
    assert.equal(h.aborts(), 1, 'the run must end');
  });

  test('a burst of tool events aborts the run once, not once per event', () => {
    const h = harness(false);

    h.subscriber({type: 'tool_execution_start', toolCallId: 'a', toolName: 'bash'});
    h.subscriber({type: 'tool_execution_update', toolCallId: 'a', toolName: 'bash'});
    h.subscriber({type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash'});

    assert.equal(h.aborts(), 1);
    assert.equal(h.emitted.filter(event => event.type === 'error').length, 1);
  });

  test('a non-tool event is not claimed, disabled or not', () => {
    assert.equal(harness(false).subscriber({type: 'message_update', text: 'hi'}), false);
    assert.equal(harness(true).subscriber({type: 'message_update', text: 'hi'}), false);
  });
});

describe('host tools enabled', () => {
  test('a start writes an audit row and emits the running call', () => {
    const h = harness(true);

    h.subscriber({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read_file',
      args: {path: '/etc/hosts'},
    });

    assert.equal(h.recorded.starts.length, 1);
    assert.equal(h.aborts(), 0);
    assert.equal(h.toolCalls.length, 1);
    assert.equal(h.toolCalls[0]?.status, 'running');

    const event = h.emitted.find(entry => entry.type === 'tool_call.updated');
    assert.ok(event);
  });

  test('a failed tool carries its error into the audit row rather than swallowing it', () => {
    const h = harness(true);

    h.subscriber({type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash'});
    h.subscriber({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: true,
      result: 'command not found',
    });

    assert.equal(h.toolCalls[0]?.status, 'error');
    assert.equal(h.toolCalls[0]?.errorMessage, 'command not found');

    // `error: event.isError ? event.result : undefined` -- during the harness split this was
    // mistranscribed as `? undefined : undefined`, silently dropping every tool failure from the
    // audit log. tsc, lint and all 407 tests stayed green, because nothing looked here.
    const end = h.recorded.ends[0] as {status: string; error?: unknown; output?: unknown};
    assert.equal(end.status, 'error');
    assert.equal(end.error, 'command not found');
    assert.equal(end.output, undefined);
  });

  test('a successful tool carries its output, and no error', () => {
    const h = harness(true);

    h.subscriber({type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash'});
    h.subscriber({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      result: 'ok',
    });

    assert.equal(h.toolCalls[0]?.status, 'complete');

    const end = h.recorded.ends[0] as {status: string; error?: unknown; output?: unknown};
    assert.equal(end.status, 'complete');
    assert.equal(end.output, 'ok');
    assert.equal(end.error, undefined);
  });
});
