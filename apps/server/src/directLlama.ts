import crypto from 'node:crypto';

import {createAsyncQueue} from './asyncQueue';
import {
  mergeChatPerformance,
  performanceFromLlamaPromptProgress,
  performanceFromLlamaTimings,
  startLlamaThroughputMonitor,
} from './llamaThroughput';
import {chatTemplateKwargsForModel, llamaRuntimeModelId} from './modelCompat';
import type {AppStore} from './store';
import type {ChatMessage, ChatPerformance, ChatStreamEvent} from './types';

export async function streamDirectLlama(
  store: AppStore,
  prompt: string,
): Promise<AsyncIterable<ChatStreamEvent>> {
  const state = await store.getState();
  const activeModel = await store.getActiveModel();
  if (!activeModel) {
    throw new Error('Select a model before chatting.');
  }

  const queue = createAsyncQueue<ChatStreamEvent>();
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
  queue.push({type: 'user_message', message: userMessage});
  queue.push({
    type: 'warning',
    message: 'Pi harness failed; falling back to direct llama.cpp chat completions.',
  });
  queue.push({type: 'assistant_start', message: assistantMessage, harness: 'llamacpp'});

  void (async () => {
    const modelId = llamaRuntimeModelId(activeModel);
    const pushPerformance = (performance: ChatPerformance) => {
      assistantMessage.performance = mergeChatPerformance(
        assistantMessage.performance,
        performance,
      );
      queue.push({
        type: 'assistant_metrics',
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
            {role: 'user', content: prompt},
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
              queue.push({type: 'assistant_delta', id: assistantMessage.id, delta});
            }
            const performance = performanceFromLlamaTimings(parsed.timings);
            if (performance) {
              pushPerformance(performance);
            }
          }
        }
      }
      await store.appendChatMessage(assistantMessage);
      queue.push({type: 'done', message: assistantMessage});
      queue.end();
    } catch (error) {
      queue.push({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      queue.end();
    } finally {
      monitor.stop();
    }
  })();

  return queue;
}
