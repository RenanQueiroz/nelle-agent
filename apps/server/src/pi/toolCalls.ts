/**
 * Reading Pi's tool events, and correlating them into the calls a client renders.
 *
 * A tool call arrives as three events -- start, update, end -- and they are correlated by a
 * stable id (Pi's `toolCallId`, or a name-and-args fingerprint when Pi does not give one), never
 * by position. The upsert is what preserves a call's input while its output is still arriving.
 * All of this is a pure reading of an untyped event: the audit rows and the SSE pushes are the
 * harness's, and stay there.
 */

import type {ToolCallEvent} from '../lib/types';

/** `tool_execution_start`, `_update` and `_end` are the only tool events Pi emits. */
export function isToolExecutionEvent(eventType: unknown): boolean {
  return typeof eventType === 'string' && eventType.startsWith('tool_execution_');
}

export function getToolCallId(event: any): string {
  return String(event.toolCallId ?? `${event.toolName ?? 'tool'}:${stringifyMaybe(event.args)}`);
}

export function upsertToolCall(calls: ToolCallEvent[], next: ToolCallEvent): ToolCallEvent {
  const index = calls.findIndex(call => call.id === next.id);
  if (index >= 0) {
    calls[index] = mergeDefined(calls[index], next);
    return calls[index];
  }
  calls.push(next);
  return next;
}

function mergeDefined(base: ToolCallEvent, next: ToolCallEvent): ToolCallEvent {
  const merged: ToolCallEvent = {...base};
  for (const [key, value] of Object.entries(next) as Array<
    [keyof ToolCallEvent, ToolCallEvent[keyof ToolCallEvent]]
  >) {
    if (value !== undefined) {
      (merged as Record<keyof ToolCallEvent, ToolCallEvent[keyof ToolCallEvent]>)[key] = value;
    }
  }
  return merged;
}

export function summarizeToolTarget(toolName: unknown, args: unknown): string | undefined {
  const data = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  const preferredKeys =
    toolName === 'bash'
      ? ['command']
      : ['path', 'filePath', 'filename', 'query', 'pattern', 'command', 'target'];
  for (const key of preferredKeys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      return value.slice(0, 160);
    }
  }
  return stringifyMaybe(args);
}

export function stringifyToolData(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  const text = extractTextContent(value);
  if (text) {
    return truncateToolDetail(text);
  }
  if (typeof value === 'string') {
    return truncateToolDetail(value);
  }
  try {
    return truncateToolDetail(JSON.stringify(value, null, 2));
  } catch {
    return truncateToolDetail(String(value));
  }
}

function extractTextContent(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const data = value as {content?: unknown};
  if (!Array.isArray(data.content)) {
    return undefined;
  }
  const text = data.content
    .map(item => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object' && typeof (item as {text?: unknown}).text === 'string') {
        return (item as {text: string}).text;
      }
      return null;
    })
    .filter(item => item != null)
    .join('\n');
  return text || undefined;
}

function stringifyMaybe(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.slice(0, 160);
  }
  try {
    return JSON.stringify(value).slice(0, 160);
  } catch {
    return String(value).slice(0, 160);
  }
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function truncateToolDetail(value: string): string {
  const limit = 20_000;
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]`;
}
