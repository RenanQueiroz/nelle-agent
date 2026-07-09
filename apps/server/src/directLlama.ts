import crypto from 'node:crypto';

import {createAsyncQueue} from './asyncQueue';
import {createErrorEvent} from './errors';
import {NELLE_WARNING_CODES} from '../../../packages/shared/src/contracts.ts';
import {withContextStatus} from '../../../packages/shared/src/context.ts';
import {createLiveContextTracker} from './conversations';
import {
  mergeChatPerformance,
  performanceFromLlamaPromptProgress,
  performanceFromLlamaTimings,
  startLlamaThroughputMonitor,
} from './llamaThroughput';
import {chatTemplateKwargsForModel, llamaRuntimeModelId} from './modelCompat';
import type {AppStore} from './store';
import type {ChatAttachmentInput, ChatMessage, ChatPerformance, ChatStreamEvent} from './types';

/**
 * Streams a chat straight through llama.cpp, bypassing Pi.
 *
 * Reachable only when Pi is disabled or has just failed, and only for the legacy
 * default conversation, because the fallback has no Pi session file to persist
 * into: its messages live in `.nelle/state.json` and nowhere else. Callers pass
 * the conversation id so the events carry it, rather than the events asserting
 * which conversation they belong to.
 */
export async function streamDirectLlama(
  store: AppStore,
  conversationId: string,
  prompt: string,
  attachments: ChatAttachmentInput[] = [],
): Promise<AsyncIterable<ChatStreamEvent>> {
  const state = await store.getState();
  const activeModel = await store.getActiveModel();
  if (!activeModel) {
    throw new Error('Select a model before chatting.');
  }

  const queue = createAsyncQueue<ChatStreamEvent>();
  const runId = `run-${crypto.randomUUID()}`;
  const runStartedAt = new Date().toISOString();
  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: prompt,
    createdAt: new Date().toISOString(),
  };
  const assistantMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    modelId: activeModel.id,
    modelRuntimeId: llamaRuntimeModelId(activeModel),
    modelAliasSnapshot: activeModel.name,
  };

  await store.appendChatMessage(userMessage);
  queue.push({
    type: 'run.started',
    runId,
    conversationId,
    kind: 'chat',
    modelId: activeModel.id,
    status: 'running',
    createdAt: runStartedAt,
  });
  queue.push({type: 'message.user.created', message: userMessage});
  queue.push({
    type: 'run.warning',
    code: NELLE_WARNING_CODES.piHarnessFallback,
    message: 'Pi harness failed; falling back to direct llama.cpp chat completions.',
  });
  queue.push({type: 'message.assistant.started', message: assistantMessage, harness: 'llamacpp'});

  void (async () => {
    const modelId = llamaRuntimeModelId(activeModel);
    const trackContext = createLiveContextTracker(activeModel.params.contextSize);
    const pushPerformance = (performance: ChatPerformance) => {
      assistantMessage.performance = mergeChatPerformance(
        assistantMessage.performance,
        performance,
      );
      const context = trackContext(assistantMessage.performance);
      if (context) {
        queue.push({
          type: 'context.updated',
          conversationId,
          ...withContextStatus(context),
          createdAt: new Date().toISOString(),
        });
      }
      queue.push({
        type: 'performance.updated',
        id: assistantMessage.id,
        performance: assistantMessage.performance,
      });
    };
    const monitor = startLlamaThroughputMonitor({
      port: state.runtime.port,
      modelId,
      onPerformance: pushPerformance,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${state.runtime.port}/v1/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          model: modelId,
          messages: [
            {role: 'system', content: 'You are Nelle Agent, a local-first personal AI agent.'},
            ...state.chat.slice(-20).map(message => ({
              role: message.role,
              content: message.content,
            })),
            {role: 'user', content: openAiUserContent(prompt, attachments)},
          ],
          stream: true,
          return_progress: true,
          sse_ping_interval: 1,
          timings_per_token: true,
          max_tokens: 512,
          ...chatTemplateKwargsForModel(activeModel),
        }),
      });
      if (!response.ok || !response.body) {
        throw new Error(`llama.cpp chat failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, {stream: true});
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) {
              continue;
            }
            const data = line.slice(5).trim();
            if (data === '[DONE]') {
              continue;
            }
            const parsed = JSON.parse(data) as {
              choices?: Array<{delta?: {content?: string}}>;
              prompt_progress?: unknown;
              timings?: unknown;
            };
            const promptPerformance = performanceFromLlamaPromptProgress(parsed.prompt_progress);
            if (promptPerformance) {
              pushPerformance(promptPerformance);
            }
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              assistantMessage.content += delta;
              queue.push({type: 'message.assistant.delta', id: assistantMessage.id, delta});
            }
            const performance = performanceFromLlamaTimings(parsed.timings);
            if (performance) {
              pushPerformance(performance);
            }
          }
        }
      }
      await store.appendChatMessage(assistantMessage);
      queue.push({type: 'message.assistant.completed', message: assistantMessage});
      queue.push({
        type: 'run.completed',
        runId,
        conversationId,
        status: 'completed',
        createdAt: new Date().toISOString(),
      });
      queue.end();
    } catch (error) {
      queue.push({
        type: 'run.completed',
        runId,
        conversationId,
        status: 'failed',
        error: {
          code: 'llama_direct_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
        createdAt: new Date().toISOString(),
      });
      queue.push(createErrorEvent(error, {fallbackCode: 'llama_direct_failed', retryable: true}));
      queue.end();
    } finally {
      monitor.stop();
    }
  })();

  return queue;
}

function openAiUserContent(
  prompt: string,
  attachments: ChatAttachmentInput[],
): string | Array<Record<string, unknown>> {
  if (attachments.length === 0) {
    return prompt;
  }
  const textParts = attachments
    .filter(attachment => attachment.kind !== 'image' && attachment.text)
    .map(
      attachment =>
        `<attachment name="${attachment.name}" type="${attachment.kind}">\n${attachment.text}\n</attachment>`,
    );
  const parts: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text:
        textParts.length === 0 ? prompt : `${prompt}\n\nAttached files:\n${textParts.join('\n\n')}`,
    },
  ];
  for (const attachment of attachments) {
    if (attachment.kind !== 'image' || !attachment.data || !attachment.mimeType) {
      continue;
    }
    const url = attachment.data.startsWith('data:')
      ? attachment.data
      : `data:${attachment.mimeType};base64,${attachment.data}`;
    parts.push({type: 'image_url', image_url: {url}});
  }
  return parts;
}
