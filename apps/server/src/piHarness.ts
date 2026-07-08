import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import {createAsyncQueue} from './asyncQueue';
import {startLlamaThroughputMonitor} from './llamaThroughput';
import {isQwenFamilyModel, llamaRuntimeModelId} from './modelCompat';
import type {AppPaths} from './paths';
import {AppStore} from './store';
import type {ChatMessage, ChatStreamEvent, ConfiguredModel, ToolCallEvent} from './types';

const PROVIDER_ID = 'nelle-llamacpp';
const TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

export class PiHarness {
  #session: any = null;
  #sessionModelId: string | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
  ) {}

  resetSession(): void {
    this.#session?.dispose?.();
    this.#session = null;
    this.#sessionModelId = null;
  }

  async streamPrompt(prompt: string): Promise<AsyncIterable<ChatStreamEvent>> {
    const activeModel = await this.store.getActiveModel();
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
      toolCalls: [],
    };

    await this.store.appendChatMessage(userMessage);
    queue.push({type: 'user_message', message: userMessage});
    queue.push({type: 'assistant_start', message: assistantMessage, harness: 'pi'});

    void this.runPiPrompt(activeModel, prompt, assistantMessage, queue).catch(error => {
      queue.push({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      queue.end();
    });

    return queue;
  }

  private async runPiPrompt(
    activeModel: ConfiguredModel,
    prompt: string,
    assistantMessage: ChatMessage,
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
  ): Promise<void> {
    const session = await this.ensureSession(activeModel);
    const state = await this.store.getState();
    const monitor = startLlamaThroughputMonitor({
      port: state.runtime.port,
      modelId: llamaRuntimeModelId(activeModel),
      onPerformance: performance => {
        assistantMessage.performance = performance;
        queue.push({type: 'assistant_metrics', id: assistantMessage.id, performance});
      },
    });
    const toolCalls: ToolCallEvent[] = [];
    const toolCallStarts = new Map<string, number>();
    let thinkingText = '';
    let providerError: string | null = null;
    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === 'text_delta') {
          const delta = String(assistantEvent.delta ?? '');
          assistantMessage.content += delta;
          queue.push({type: 'assistant_delta', id: assistantMessage.id, delta});
        }
        if (assistantEvent?.type === 'thinking_delta') {
          thinkingText += String(assistantEvent.delta ?? '');
        }
        if (assistantEvent?.type === 'error') {
          providerError =
            assistantEvent.error?.errorMessage ??
            assistantEvent.errorMessage ??
            'Pi provider error';
        }
      }

      if (event.type === 'tool_execution_start') {
        const id = getToolCallId(event);
        const call: ToolCallEvent = {
          id,
          name: String(event.toolName ?? 'tool'),
          target: summarizeToolTarget(event.toolName, event.args),
          status: 'running',
          input: stringifyToolData(event.args),
        };
        toolCallStarts.set(id, Date.now());
        toolCalls.push(call);
        queue.push({type: 'tool', call: {...call}});
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
        queue.push({type: 'tool', call: {...call}});
      }

      if (event.type === 'tool_execution_end') {
        const id = getToolCallId(event);
        const startedAt = toolCallStarts.get(id);
        const call = upsertToolCall(toolCalls, {
          id,
          name: String(event.toolName ?? 'tool'),
          target: summarizeToolTarget(event.toolName, event.args),
          status: event.isError ? 'error' : 'complete',
          input: stringifyToolData(event.args),
          output: stringifyToolData(event.result),
          duration: startedAt ? formatDuration(Date.now() - startedAt) : undefined,
          errorMessage: event.isError ? stringifyToolData(event.result) : undefined,
        });
        queue.push({type: 'tool', call: {...call}});
      }
    });

    try {
      await session.prompt(prompt);
      assistantMessage.toolCalls = toolCalls;
      if (!assistantMessage.content.trim()) {
        const fallback = thinkingText.trim();
        if (fallback) {
          queue.push({
            type: 'warning',
            message:
              'The model returned reasoning content without final text; showing the reasoning output.',
          });
          assistantMessage.content = fallback;
          queue.push({type: 'assistant_delta', id: assistantMessage.id, delta: fallback});
        } else {
          throw new Error(
            providerError ??
              'The Pi harness completed without assistant text. Check the llama.cpp model id and logs.',
          );
        }
      }
      await this.store.appendChatMessage(assistantMessage);
      queue.push({type: 'done', message: assistantMessage});
      queue.end();
    } finally {
      monitor.stop();
      unsubscribe();
    }
  }

  private async ensureSession(activeModel: ConfiguredModel): Promise<any> {
    if (this.#session && this.#sessionModelId === activeModel.id) {
      return this.#session;
    }

    this.#session?.dispose?.();
    await this.writePiModels(activeModel);

    const authStorage = AuthStorage.create(this.paths.piAuthPath);
    authStorage.setRuntimeApiKey(PROVIDER_ID, 'nelle-local');
    const modelRegistry = ModelRegistry.create(authStorage, this.paths.piModelsPath);
    const modelId = llamaRuntimeModelId(activeModel);
    const model = modelRegistry.find(PROVIDER_ID, modelId);
    if (!model) {
      throw new Error(`Pi could not resolve model ${PROVIDER_ID}/${modelId}.`);
    }

    const resourceLoader = new DefaultResourceLoader({
      cwd: this.paths.repoRoot,
      agentDir: this.paths.piDir,
      systemPromptOverride: () =>
        [
          'You are Nelle Agent, a local-first personal AI agent.',
          'You may use host file and shell tools when needed.',
          'This POC runs unsandboxed as the launching OS user, so be careful and explain destructive operations before running them.',
        ].join('\n'),
    });
    await resourceLoader.reload();

    const {session} = await createAgentSession({
      agentDir: this.paths.piDir,
      cwd: this.paths.repoRoot,
      model,
      thinkingLevel: 'off',
      tools: TOOL_ALLOWLIST,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
    } as any);

    this.#session = session;
    this.#sessionModelId = activeModel.id;
    return session;
  }

  private async writePiModels(activeModel: ConfiguredModel): Promise<void> {
    await fs.mkdir(this.paths.piDir, {recursive: true});
    const state = await this.store.getState();
    const models = state.models.map(model => ({
      id: llamaRuntimeModelId(model),
      name: model.name,
      reasoning: isQwenFamilyModel(model),
      input: ['text'],
      contextWindow: model.params.contextSize,
      maxTokens: Math.min(512, Math.max(128, Math.floor(model.params.contextSize / 8))),
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      ...(isQwenFamilyModel(model)
        ? {compat: {thinkingFormat: 'qwen-chat-template' as const}}
        : {}),
    }));

    const config = {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: `http://127.0.0.1:${state.runtime.port}/v1`,
          api: 'openai-completions',
          apiKey: 'nelle-local',
          authHeader: false,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: false,
            maxTokensField: 'max_tokens',
          },
          models,
        },
      },
      activeModel: llamaRuntimeModelId(activeModel),
    };

    await fs.writeFile(this.paths.piModelsPath, `${JSON.stringify(config, null, 2)}\n`);
  }
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

function getToolCallId(event: any): string {
  return String(event.toolCallId ?? `${event.toolName ?? 'tool'}:${stringifyMaybe(event.args)}`);
}

function upsertToolCall(calls: ToolCallEvent[], next: ToolCallEvent): ToolCallEvent {
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

function summarizeToolTarget(toolName: unknown, args: unknown): string | undefined {
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

function stringifyToolData(value: unknown): string | undefined {
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

function formatDuration(durationMs: number): string {
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
