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
import {
  beginLlamaPerformanceCapture,
  mergeChatPerformance,
  startLlamaThroughputMonitor,
} from './llamaThroughput';
import {localLlamaProxyBaseUrl} from './llamaProxy';
import {chatTemplateKwargsForModel, isQwenFamilyModel, llamaRuntimeModelId} from './modelCompat';
import type {AppPaths} from './paths';
import {AppStore} from './store';
import type {ConversationRepository, SyncConversationEntry} from './conversations';
import type {ConversationEntryProjection} from '../../../packages/shared/src/conversations.ts';
import type {
  ChatMessage,
  ChatPerformance,
  ChatStreamEvent,
  ConfiguredModel,
  ToolCallEvent,
} from './types';

const PROVIDER_ID = 'nelle-llamacpp';
const TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

type ManagedSession = {
  conversationId: string;
  modelId: string;
  session: any;
};

export class PiHarness {
  #sessions = new Map<string, ManagedSession>();

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly conversations: ConversationRepository,
  ) {}

  resetSession(conversationId?: string): void {
    if (conversationId) {
      this.#sessions.get(conversationId)?.session.dispose?.();
      this.#sessions.delete(conversationId);
      return;
    }
    for (const managed of this.#sessions.values()) {
      managed.session.dispose?.();
    }
    this.#sessions.clear();
  }

  async abortConversation(conversationId: string): Promise<boolean> {
    const managed = this.#sessions.get(conversationId);
    if (!managed) {
      return false;
    }
    await managed.session.abort?.();
    this.conversations.setConversationStatus(conversationId, 'ready');
    return true;
  }

  async compactConversation(
    conversationId: string,
    customInstructions?: string,
  ): Promise<{compacted: boolean}> {
    const activeModel = await this.store.getActiveModel();
    if (!activeModel) {
      throw new Error('Select a model before compacting conversation context.');
    }
    this.conversations.ensureConversation(conversationId, {
      defaultModelId: activeModel.id,
    });
    this.conversations.setConversationStatus(conversationId, 'compacting');

    try {
      const session = await this.ensureSession(conversationId, activeModel);
      if ((session.messages?.length ?? 0) === 0) {
        throw new Error('There is no conversation context to compact.');
      }
      await session.compact(customInstructions?.trim() || undefined);
      this.syncPiConversation(conversationId, session, activeModel, undefined, 'compacting');
      return {compacted: true};
    } finally {
      this.conversations.setConversationStatus(conversationId, 'ready');
    }
  }

  abortCompaction(conversationId: string): boolean {
    const managed = this.#sessions.get(conversationId);
    if (!managed) {
      return false;
    }
    managed.session.abortCompaction?.();
    this.conversations.setConversationStatus(conversationId, 'ready');
    return true;
  }

  async streamPrompt(
    prompt: string,
    conversationId = 'poc-default',
  ): Promise<AsyncIterable<ChatStreamEvent>> {
    const activeModel = await this.store.getActiveModel();
    if (!activeModel) {
      throw new Error('Select a model before chatting.');
    }

    this.conversations.ensureConversation(conversationId, {
      title: prompt.slice(0, 80) || 'New chat',
      defaultModelId: activeModel.id,
    });
    this.conversations.setConversationStatus(conversationId, 'running');

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
      toolCalls: [],
    };

    if (conversationId === 'poc-default') {
      await this.store.appendChatMessage(userMessage);
    }
    queue.push({type: 'user_message', message: userMessage});
    queue.push({type: 'assistant_start', message: assistantMessage, harness: 'pi'});

    void this.runPiPrompt(activeModel, conversationId, prompt, assistantMessage, queue).catch(
      error => {
        this.conversations.setConversationStatus(conversationId, 'ready');
        queue.push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        queue.end();
      },
    );

    return queue;
  }

  async regenerateMessage(input: {
    conversationId: string;
    assistantMessageId: string;
    modelId?: string;
  }): Promise<AsyncIterable<ChatStreamEvent>> {
    const activeModel = input.modelId
      ? await this.store.getModel(input.modelId)
      : await this.store.getActiveModel();
    if (!activeModel) {
      throw new Error(
        input.modelId ? `Unknown model: ${input.modelId}` : 'Select a model before regenerating.',
      );
    }

    const source = this.conversations.getRegenerationSource(
      input.conversationId,
      input.assistantMessageId,
    );
    if (!source) {
      throw new Error('Could not find the assistant response to regenerate.');
    }
    const prompt = source.userEntry.textPreview?.trim();
    if (!prompt) {
      throw new Error('The source user message is empty and cannot be regenerated.');
    }

    this.conversations.setConversationStatus(input.conversationId, 'running');
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
      regeneratesPiEntryId: source.regeneratesPiEntryId,
      displayGroupId: source.displayGroupId,
      toolCalls: [],
    };

    queue.push({type: 'user_message', message: userMessage});
    queue.push({type: 'assistant_start', message: assistantMessage, harness: 'pi'});

    void this.runPiPrompt(activeModel, input.conversationId, prompt, assistantMessage, queue, {
      branchFromPiEntryId: source.branchFromPiEntryId,
      regeneratesPiEntryId: source.regeneratesPiEntryId,
      displayGroupId: source.displayGroupId,
      appendLegacyState: false,
    }).catch(error => {
      this.conversations.setConversationStatus(input.conversationId, 'ready');
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
    conversationId: string,
    prompt: string,
    assistantMessage: ChatMessage,
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
    options: {
      branchFromPiEntryId?: string | null;
      regeneratesPiEntryId?: string;
      displayGroupId?: string;
      appendLegacyState?: boolean;
    } = {},
  ): Promise<void> {
    const session = await this.ensureSession(conversationId, activeModel);
    if (options.branchFromPiEntryId !== undefined) {
      if (options.branchFromPiEntryId === null) {
        session.sessionManager.resetLeaf();
      } else {
        session.sessionManager.branch(options.branchFromPiEntryId);
      }
    }
    const state = await this.store.getState();
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
    const capture = beginLlamaPerformanceCapture(pushPerformance);
    const monitor = startLlamaThroughputMonitor({
      port: state.runtime.port,
      modelId: llamaRuntimeModelId(activeModel),
      onPerformance: pushPerformance,
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
      if (conversationId === 'poc-default' && options.appendLegacyState !== false) {
        await this.store.appendChatMessage(assistantMessage);
      }
      const syncedEntries = this.syncPiConversation(
        conversationId,
        session,
        activeModel,
        assistantMessage,
        'running',
        {
          regeneratesPiEntryId: options.regeneratesPiEntryId,
          displayGroupId: options.displayGroupId,
        },
      );
      queue.push({type: 'done', message: assistantMessage});
      const title = await this.maybeGenerateConversationTitle(
        conversationId,
        activeModel,
        syncedEntries,
      );
      if (title) {
        queue.push({type: 'conversation_title', conversationId, title});
      }
      queue.end();
    } finally {
      monitor.stop();
      capture.stop();
      unsubscribe();
      this.conversations.setConversationStatus(conversationId, 'ready');
    }
  }

  private async ensureSession(conversationId: string, activeModel: ConfiguredModel): Promise<any> {
    const cached = this.#sessions.get(conversationId);
    if (cached && cached.modelId === activeModel.id) {
      return cached.session;
    }

    cached?.session.dispose?.();
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

    await fs.mkdir(this.paths.piSessionsDir, {recursive: true});
    const binding = this.conversations.getPiSessionBinding(conversationId);
    const sessionManager = binding?.piSessionPath
      ? SessionManager.open(binding.piSessionPath, this.paths.piSessionsDir, this.paths.repoRoot)
      : SessionManager.create(this.paths.repoRoot, this.paths.piSessionsDir);

    const {session} = await createAgentSession({
      agentDir: this.paths.piDir,
      cwd: this.paths.repoRoot,
      model,
      thinkingLevel: 'off',
      tools: TOOL_ALLOWLIST,
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager,
    } as any);

    const sessionFile = session.sessionFile ?? sessionManager.getSessionFile();
    if (sessionFile) {
      this.conversations.attachPiSession(conversationId, {
        piSessionPath: sessionFile,
        piSessionId: session.sessionId ?? sessionManager.getSessionId(),
        activeLeafPiEntryId: sessionManager.getLeafId(),
      });
    }
    this.#sessions.set(conversationId, {
      conversationId,
      modelId: activeModel.id,
      session,
    });
    return session;
  }

  private syncPiConversation(
    conversationId: string,
    session: any,
    activeModel: ConfiguredModel,
    assistantMessage?: ChatMessage,
    status: 'running' | 'compacting' = 'running',
    metadata: {
      regeneratesPiEntryId?: string;
      displayGroupId?: string;
    } = {},
  ): SyncConversationEntry[] {
    const branch = session.sessionManager.getBranch() as any[];
    const existingEntries = new Map(
      this.conversations
        .getConversationEntries(conversationId)
        .map(entry => [entry.piEntryId, entry] as const),
    );
    const entries: SyncConversationEntry[] = [];
    let lastAssistantEntryId: string | null = null;
    for (const entry of branch) {
      if (entry.type === 'compaction') {
        entries.push({
          piEntryId: String(entry.id),
          parentPiEntryId: entry.parentId ?? null,
          entryType: entry.type,
          text: String(entry.summary ?? 'Context compacted.'),
          createdAt: String(entry.timestamp ?? new Date().toISOString()),
          displayGroupId: String(entry.id),
        });
        continue;
      }
      if (entry.type !== 'message') {
        continue;
      }
      const role = normalizeChatRole(entry.message?.role);
      const text = extractMessageText(entry.message);
      const projection: SyncConversationEntry = {
        piEntryId: String(entry.id),
        parentPiEntryId: entry.parentId ?? null,
        entryType: entry.type,
        role,
        text,
        createdAt: String(entry.timestamp ?? new Date().toISOString()),
        displayGroupId: String(entry.id),
      };
      if (role === 'assistant') {
        const existingEntry = existingEntries.get(projection.piEntryId);
        projection.modelId = existingEntry?.modelId ?? activeModel.id;
        projection.modelRuntimeId =
          existingEntry?.modelRuntimeId ?? llamaRuntimeModelId(activeModel);
        projection.modelAliasSnapshot = existingEntry?.modelAliasSnapshot ?? activeModel.name;
        lastAssistantEntryId = projection.piEntryId;
      }
      entries.push(projection);
    }

    if (assistantMessage && lastAssistantEntryId) {
      const lastAssistant = entries.find(entry => entry.piEntryId === lastAssistantEntryId);
      if (lastAssistant) {
        lastAssistant.modelId = assistantMessage.modelId;
        lastAssistant.modelRuntimeId = assistantMessage.modelRuntimeId;
        lastAssistant.modelAliasSnapshot = assistantMessage.modelAliasSnapshot;
        lastAssistant.performance = assistantMessage.performance;
        lastAssistant.toolCalls = assistantMessage.toolCalls;
        lastAssistant.regeneratesPiEntryId = metadata.regeneratesPiEntryId;
        lastAssistant.displayGroupId = metadata.displayGroupId ?? metadata.regeneratesPiEntryId;
      }
    }

    prependExistingVariantGroup(
      entries,
      existingEntries,
      metadata.regeneratesPiEntryId,
      metadata.displayGroupId,
    );

    this.conversations.replaceConversationProjection(conversationId, {
      piSessionPath: session.sessionFile,
      piSessionId: session.sessionId,
      activeLeafPiEntryId: session.sessionManager.getLeafId(),
      lastSyncedPiEntryId: session.sessionManager.getLeafId(),
      status,
      entries,
    });
    return entries;
  }

  private async maybeGenerateConversationTitle(
    conversationId: string,
    activeModel: ConfiguredModel,
    entries: SyncConversationEntry[],
  ): Promise<string | null> {
    if (this.conversations.getTitleSource(conversationId) !== 'fallback') {
      return null;
    }
    const userMessages = entries.filter(entry => entry.role === 'user' && entry.text.trim());
    const assistantMessages = entries.filter(
      entry => entry.role === 'assistant' && entry.text.trim(),
    );
    if (userMessages.length !== 1 || assistantMessages.length !== 1) {
      return null;
    }
    const title = await this.generateTitleWithLlama(
      activeModel,
      userMessages[0]!.text,
      assistantMessages[0]!.text,
    );
    if (!title) {
      return null;
    }
    this.conversations.setGeneratedTitle(conversationId, title);
    return title;
  }

  private async generateTitleWithLlama(
    activeModel: ConfiguredModel,
    userPrompt: string,
    assistantResponse: string,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${localLlamaProxyBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: controller.signal,
        body: JSON.stringify({
          model: llamaRuntimeModelId(activeModel),
          messages: [
            {
              role: 'system',
              content:
                'Create concise conversation titles. Return only the title, with no quotes, markdown, punctuation suffix, or explanation.',
            },
            {
              role: 'user',
              content: [
                'Create a concise title for this conversation.',
                'Limit it to 6 words.',
                '',
                `User: ${userPrompt}`,
                `Assistant: ${assistantResponse}`,
              ].join('\n'),
            },
          ],
          stream: false,
          max_tokens: 24,
          temperature: 0.2,
          ...chatTemplateKwargsForModel(activeModel),
        }),
      });
      if (!response.ok) {
        return null;
      }
      const parsed = (await response.json()) as {
        choices?: Array<{message?: {content?: string}; text?: string}>;
      };
      return sanitizeGeneratedTitle(
        parsed.choices?.[0]?.message?.content ?? parsed.choices?.[0]?.text ?? '',
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
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
          baseUrl: localLlamaProxyBaseUrl(),
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

function prependVariantEntry(
  entries: SyncConversationEntry[],
  entry: SyncConversationEntry | ConversationEntryProjection,
): void {
  if (entries.some(item => item.piEntryId === entry.piEntryId)) {
    return;
  }
  entries.unshift({
    piEntryId: entry.piEntryId,
    parentPiEntryId: entry.parentPiEntryId ?? null,
    entryType: entry.entryType,
    role: entry.role ?? null,
    text: isProjectionEntry(entry) ? (entry.textPreview ?? '') : entry.text,
    createdAt: entry.createdAt,
    modelId: entry.modelId,
    modelRuntimeId: entry.modelRuntimeId,
    modelAliasSnapshot: entry.modelAliasSnapshot,
    performance: entry.performance,
    toolCalls: entry.toolCalls,
    attachmentSummary: entry.attachmentSummary,
    regeneratesPiEntryId: entry.regeneratesPiEntryId ?? null,
    displayGroupId: entry.displayGroupId ?? entry.piEntryId,
  });
}

function prependExistingVariantGroup(
  entries: SyncConversationEntry[],
  existingEntries: Map<string, ConversationEntryProjection>,
  regeneratesPiEntryId?: string,
  displayGroupId?: string,
): void {
  if (!regeneratesPiEntryId) {
    return;
  }
  const sourceAssistant = existingEntries.get(regeneratesPiEntryId);
  const groupId = displayGroupId ?? sourceAssistant?.displayGroupId ?? regeneratesPiEntryId;
  const variantAssistants = [...existingEntries.values()]
    .filter(
      entry =>
        entry.role === 'assistant' && belongsToVariantGroup(entry, regeneratesPiEntryId, groupId),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const groupEntries: ConversationEntryProjection[] = [];
  const seen = new Set<string>();
  for (const assistant of variantAssistants) {
    const parent = assistant.parentPiEntryId
      ? existingEntries.get(assistant.parentPiEntryId)
      : undefined;
    if (parent && !seen.has(parent.piEntryId)) {
      groupEntries.push(parent);
      seen.add(parent.piEntryId);
    }
    if (!seen.has(assistant.piEntryId)) {
      groupEntries.push(assistant);
      seen.add(assistant.piEntryId);
    }
  }
  for (let index = groupEntries.length - 1; index >= 0; index -= 1) {
    prependVariantEntry(entries, groupEntries[index]!);
  }
}

function belongsToVariantGroup(
  entry: ConversationEntryProjection,
  regeneratesPiEntryId: string,
  displayGroupId: string,
): boolean {
  return (
    entry.piEntryId === regeneratesPiEntryId ||
    entry.displayGroupId === displayGroupId ||
    entry.regeneratesPiEntryId === regeneratesPiEntryId ||
    entry.regeneratesPiEntryId === displayGroupId
  );
}

function isProjectionEntry(
  entry: SyncConversationEntry | ConversationEntryProjection,
): entry is ConversationEntryProjection {
  return 'textPreview' in entry;
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

function normalizeChatRole(role: unknown): ChatMessage['role'] | undefined {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }
  return undefined;
}

function extractMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as {content?: unknown}).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(item => {
      if (typeof item === 'string') {
        return item;
      }
      if (!item || typeof item !== 'object') {
        return '';
      }
      const type = (item as {type?: unknown}).type;
      if (type === 'text' && typeof (item as {text?: unknown}).text === 'string') {
        return (item as {text: string}).text;
      }
      if (type === 'toolCall' && typeof (item as {name?: unknown}).name === 'string') {
        return `[tool call: ${(item as {name: string}).name}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function sanitizeGeneratedTitle(value: string): string | null {
  const title = value
    .split(/\r?\n/)[0]
    ?.replace(/^["'`*_#\s]+|["'`*_\s]+$/g, '')
    .replace(/[.!?:;,]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    return null;
  }
  return title.slice(0, 80);
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
