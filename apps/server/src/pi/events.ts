/**
 * The SSE envelopes a run puts on the wire, and the run record they are built from.
 *
 * Every event here is dotted and its `type` is the wire contract -- a client switches on it, so
 * these factories are the one place a run's shape becomes a `ChatStreamEvent`. They read an
 * `ActiveRun` and nothing else: no repository, no session, no llama.cpp. `ActiveRun` itself lives
 * here because it is what every one of them takes; the harness keeps the map of them, because the
 * map is the weld.
 */

import type {createAsyncQueue} from '../lib/asyncQueue';
import {withContextStatus} from '../contracts/context.ts';
import type {
  ConversationContextUsage,
  RunKind,
  TerminalRunStatus,
} from '../contracts/conversations.ts';
import type {NelleError} from '../contracts/contracts.ts';
import type {ChatStreamEvent} from '../lib/types';

export type ActiveRun = {
  runId: string;
  conversationId: string;
  kind: RunKind;
  modelId?: string;
  abortRequested: boolean;
  abortController?: AbortController;
  abortWarning?: NelleError;
};

export function createRunStartedEvent(run: ActiveRun): ChatStreamEvent {
  return {
    type: 'run.started',
    runId: run.runId,
    conversationId: run.conversationId,
    kind: run.kind,
    modelId: run.modelId,
    status: 'running',
    createdAt: new Date().toISOString(),
  };
}

export function createRunAbortedEvent(
  run: ActiveRun,
  reason: 'user' | 'server' | 'runtime',
): ChatStreamEvent {
  return {
    type: 'run.aborted',
    runId: run.runId,
    conversationId: run.conversationId,
    reason,
    createdAt: new Date().toISOString(),
  };
}

export function pushRunAbortedEvents(
  queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>> | undefined,
  run: ActiveRun,
): void {
  queue?.push(createRunAbortedEvent(run, 'user'));
  if (run.abortWarning) {
    queue?.push({
      type: 'run.warning',
      code: run.abortWarning.code,
      message: run.abortWarning.message,
      detail: run.abortWarning.detail,
    });
  }
  queue?.push(createRunCompletedEvent(run, 'aborted'));
}

export function createRunCompletedEvent(
  run: ActiveRun,
  status: TerminalRunStatus,
  error?: {code: string; message: string; retryable?: boolean},
): ChatStreamEvent {
  return {
    type: 'run.completed',
    runId: run.runId,
    conversationId: run.conversationId,
    status,
    error,
    createdAt: new Date().toISOString(),
  };
}

export function createContextUpdatedEvent(
  conversationId: string,
  context: ConversationContextUsage,
): ChatStreamEvent {
  return {
    type: 'context.updated',
    conversationId,
    ...withContextStatus(context),
    createdAt: new Date().toISOString(),
  };
}

export function createCompactStartedEvent(
  run: ActiveRun,
  instructions: string | undefined,
): ChatStreamEvent {
  const trimmedInstructions = instructions?.trim();
  return {
    type: 'compact.started',
    runId: run.runId,
    conversationId: run.conversationId,
    instructions: trimmedInstructions || undefined,
    createdAt: new Date().toISOString(),
  };
}

export function createCompactCompletedEvent(run: ActiveRun): ChatStreamEvent {
  return {
    type: 'compact.completed',
    runId: run.runId,
    conversationId: run.conversationId,
    compacted: true,
    createdAt: new Date().toISOString(),
  };
}

export function createCompactFailedEvent(
  run: ActiveRun,
  error: {code: string; message: string; retryable?: boolean},
): ChatStreamEvent {
  return {
    type: 'compact.failed',
    runId: run.runId,
    conversationId: run.conversationId,
    error,
    createdAt: new Date().toISOString(),
  };
}

export function createConversationTitleEvent(
  conversationId: string,
  title: string,
): ChatStreamEvent {
  return {
    type: 'conversation.updated',
    conversationId,
    title,
    titleSource: 'generated',
    updatedAt: new Date().toISOString(),
  };
}
