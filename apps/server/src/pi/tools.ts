/**
 * The subscriber that turns Pi's tool events into audit rows and `tool_call.updated` frames.
 *
 * This is not `hostTools.ts` -- that is the repository the audit rows go into, and the switch
 * that says whether host tools may run at all. This is the half that *listens*, and the reason it
 * is worth naming: the gate it enforces is a runtime one. `tools: []` at session construction only
 * stops Pi from offering the tools, and a cached session, a Pi retry, or a user turning host tools
 * off mid-run can each put a tool event on this subscriber anyway. It fails closed.
 *
 * It answers `true` for any tool event, so the caller knows the event is spoken for and its own
 * `message_update` handling never sees one.
 */

import {createErrorEvent} from '../http/errors';
import type {createAsyncQueue} from '../lib/asyncQueue';
import type {ChatStreamEvent, ToolCallEvent} from '../lib/types';
import {ToolsDisabledError} from './errors.ts';
import type {HostToolRepository} from './hostTools';
import {
  formatDuration,
  getToolCallId,
  isToolExecutionEvent,
  stringifyToolData,
  summarizeToolTarget,
  upsertToolCall,
} from './toolCalls.ts';

export function createToolEventSubscriber(input: {
  hostTools: HostToolRepository;
  conversationId: string;
  queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>;
  /** The run's own list, so the assistant message keeps the calls after the stream ends. */
  toolCalls: ToolCallEvent[];
  abortRun: () => void;
}): (event: any) => boolean {
  const {hostTools, conversationId, queue, toolCalls, abortRun} = input;
  let toolsDisabledAborted = false;
  const toolCallStarts = new Map<string, number>();

  return (event: any): boolean => {
    if (!isToolExecutionEvent(event.type)) {
      return false;
    }

    // `tools: []` at session construction is a build-time gate, not a runtime
    // one. A cached session, a Pi retry, or a future Pi version could still
    // emit a tool event; the user disabling host tools mid-run certainly can.
    // Fail closed: no audit row, no tool event, and the run ends.
    if (!hostTools.areToolsEnabled()) {
      if (!toolsDisabledAborted) {
        toolsDisabledAborted = true;
        queue.push(createErrorEvent(new ToolsDisabledError()));
        abortRun();
      }
      return true;
    }

    if (event.type === 'tool_execution_start') {
      const id = getToolCallId(event);
      const startedAt = Date.now();
      const call: ToolCallEvent = {
        id,
        name: String(event.toolName ?? 'tool'),
        target: summarizeToolTarget(event.toolName, event.args),
        status: 'running',
        input: stringifyToolData(event.args),
      };
      toolCallStarts.set(id, startedAt);
      hostTools.recordToolStart({
        conversationId,
        piToolCallId: id,
        toolName: call.name,
        args: event.args,
        startedAt: new Date(startedAt),
      });
      toolCalls.push(call);
      queue.push({type: 'tool_call.updated', call: {...call}});
    }

    if (event.type === 'tool_execution_update') {
      const id = getToolCallId(event);
      const call = upsertToolCall(toolCalls, {
        id,
        name: String(event.toolName ?? 'tool'),
        target: summarizeToolTarget(event.toolName, event.args),
        status: 'running',
        input: stringifyToolData(event.args),
        output: stringifyToolData(event.partialResult),
      });
      queue.push({type: 'tool_call.updated', call: {...call}});
    }

    if (event.type === 'tool_execution_end') {
      const id = getToolCallId(event);
      const startedAt = toolCallStarts.get(id);
      const completedAt = Date.now();
      const durationMs = startedAt ? completedAt - startedAt : undefined;
      const call = upsertToolCall(toolCalls, {
        id,
        name: String(event.toolName ?? 'tool'),
        target: summarizeToolTarget(event.toolName, event.args),
        status: event.isError ? 'error' : 'complete',
        input: stringifyToolData(event.args),
        output: stringifyToolData(event.result),
        duration: durationMs == null ? undefined : formatDuration(durationMs),
        errorMessage: event.isError ? stringifyToolData(event.result) : undefined,
      });
      hostTools.recordToolEnd({
        conversationId,
        piToolCallId: id,
        toolName: call.name,
        args: event.args,
        status: event.isError ? 'error' : 'complete',
        output: event.isError ? undefined : event.result,
        error: event.isError ? event.result : undefined,
        completedAt: new Date(completedAt),
        durationMs,
      });
      queue.push({type: 'tool_call.updated', call: {...call}});
    }

    return true;
  };
}
