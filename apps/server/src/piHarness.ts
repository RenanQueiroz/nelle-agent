import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
} from '@earendil-works/pi-coding-agent';

import {createAsyncQueue} from './asyncQueue';
import {beginLlamaRequestCapture} from './llamaProxy';
import {
  beginLlamaPerformanceCapture,
  mergeChatPerformance,
  startLlamaThroughputMonitor,
} from './llamaThroughput';
import {localLlamaProxyBaseUrl} from './llamaProxy';
import {chatTemplateKwargsForModel, llamaRuntimeModelId} from './modelCompat';
import {createErrorEvent} from './errors';
import type {AppPaths} from './paths';
import {AppStore} from './store';
import {resolveConversationModel} from './conversationModel';
import {
  createLiveContextTracker,
  LEGACY_DEFAULT_CONVERSATION_ID,
  type ConversationRepository,
  type SyncConversationEntry,
} from './conversations';
import type {HostToolRepository} from './hostTools';
import type {ModelCacheRepository} from './modelCache';
import type {SettingsRepository} from './settings';
import {effectiveContextWindow, requireContextWindow} from './contextWindow';
import {
  CUSTOM_INSTRUCTIONS_KEY,
  INSTRUCTIONS_SETTINGS_SLUG,
  REASONING_SETTINGS_SLUG,
  TITLES_SETTINGS_SLUG,
} from '../../../packages/shared/src/settingsKeys.ts';
import {reasoningBudgetsFromSettings} from '../../../packages/shared/src/settings.ts';
import {
  TITLE_SYSTEM_PROMPT,
  firstLineTitle,
  readTitleSettings,
  renderTitlePrompt,
  sanitizeGeneratedTitle,
  type TitleSettings,
} from '../../../packages/shared/src/titles.ts';
import type {
  AttachmentMetadata,
  ConversationContextUsage,
  ConversationEntryProjection,
  ConversationSnapshot,
  ConversationStatus,
  RunKind,
  TerminalRunStatus,
} from '../../../packages/shared/src/conversations.ts';
import type {ChatAttachmentInput} from '../../../packages/shared/src/contracts.ts';
import {
  isClampedReplyBudget,
  isReplyBudgetExhausted,
  MIN_USABLE_REPLY_TOKENS,
  minimumUsableContextSize,
  PI_CONTEXT_SAFETY_TOKENS,
  PI_ESTIMATED_IMAGE_TOKENS,
  replyTokenBudget,
} from '../../../packages/shared/src/piContext.ts';
import {
  createThinkingEndTagFilter,
  isReasoningEnabled,
  piThinkingLevel,
  reasoningBudgetTokens,
  stripLeadingThinkingEndTag,
} from '../../../packages/shared/src/reasoning.ts';
import {withContextStatus} from '../../../packages/shared/src/context.ts';
import type {
  AbortConversationResult,
  ChatMessage,
  ChatPerformance,
  ChatStreamEvent,
  ConfiguredModel,
  LlamaModelProps,
  ToolCallEvent,
} from './types';
import type {NelleError} from '../../../packages/shared/src/contracts.ts';
import {NELLE_ERROR_CODES, NELLE_WARNING_CODES} from '../../../packages/shared/src/contracts.ts';

const PROVIDER_ID = 'nelle-llamacpp';
const TOOL_ALLOWLIST = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];
const ATTACHMENT_TEXT_INLINE_MAX = 200_000;

type ManagedSession = {
  conversationId: string;
  modelId: string;
  /**
   * Pi reads `contextWindow` from `.pi/models.json` at session creation and
   * clamps against it for the session's life. Loading a model for the first time
   * -- or editing its `c` cap -- changes that number, and a session that did not
   * notice keeps clamping against one nobody believes.
   */
  contextWindow: number;
  session: any;
};

type ActiveRun = {
  runId: string;
  conversationId: string;
  kind: RunKind;
  modelId?: string;
  abortRequested: boolean;
  abortController?: AbortController;
  abortWarning?: NelleError;
};

type LlamaRuntimeServices = {
  tokenize?: (content: string) => Promise<{tokens: number}>;
  getModelProps?: (modelId: string) => Promise<LlamaModelProps>;
  verifyAbortIdle?: (input: {modelId?: string; graceMs?: number}) => Promise<{
    warning?: NelleError;
  }>;
};

type PreparedPromptAttachment = {
  input: ChatAttachmentInput;
  metadata: AttachmentMetadata;
  text?: string;
  image?: {
    type: 'image';
    data: string;
    mimeType: string;
  };
};

type PreparedPromptAttachments = {
  items: PreparedPromptAttachment[];
  metadata: AttachmentMetadata[];
  uploadIds: string[];
};

export class PiHarness {
  #sessions = new Map<string, ManagedSession>();
  #activeRuns = new Map<string, ActiveRun>();

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly conversations: ConversationRepository,
    private readonly hostTools: HostToolRepository,
    private readonly llamaRuntime?: LlamaRuntimeServices,
    private readonly modelCache?: ModelCacheRepository,
    /** Absent only in tests that do not touch a setting; they get the defaults. */
    private readonly settings?: SettingsRepository,
  ) {}

  private titleSettings(): TitleSettings {
    return readTitleSettings(this.settings?.tryGetGroup(TITLES_SETTINGS_SLUG));
  }

  /** What llama.cpp reports for this model, or the configured cap, or `null`. */
  private contextWindow(model: ConfiguredModel): number | null {
    return effectiveContextWindow(model, this.modelCache);
  }

  private customInstructions(): string {
    const values = this.settings?.tryGetGroup(INSTRUCTIONS_SETTINGS_SLUG);
    const text = values?.[CUSTOM_INSTRUCTIONS_KEY];
    return typeof text === 'string' ? text : '';
  }

  resetSession(conversationId?: string): void {
    if (conversationId) {
      this.#sessions.get(conversationId)?.session.dispose?.();
      this.#sessions.delete(conversationId);
      this.#activeRuns.delete(conversationId);
      return;
    }
    for (const managed of this.#sessions.values()) {
      managed.session.dispose?.();
    }
    this.#sessions.clear();
    this.#activeRuns.clear();
  }

  async createConversation(input: {
    title?: string;
    defaultModelId?: string | null;
  }): Promise<ConversationSnapshot> {
    const conversation = this.conversations.createConversation(input);
    const sessionManager = SessionManager.create(this.paths.repoRoot, this.paths.piSessionsDir);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error('Pi did not allocate a session file for the new conversation.');
    }
    await ensureSessionFile(sessionFile, sessionManager);
    this.conversations.attachPiSession(conversation.id, {
      piSessionPath: sessionFile,
      piSessionId: sessionManager.getSessionId(),
      activeLeafPiEntryId: sessionManager.getLeafId(),
    });
    const snapshot = this.conversations.getSnapshot(conversation.id, await this.store.getState());
    if (!snapshot) {
      throw new Error('Created conversation snapshot was not available.');
    }
    return snapshot;
  }

  async migrateLegacyDefaultConversation(): Promise<void> {
    if (process.env.NELLE_PI_DISABLED === '1') {
      return;
    }
    const state = await this.store.getState();
    const existing = this.conversations.syncLegacyDefaultConversationFromState(state);
    if (
      state.chat.length === 0 ||
      this.conversations.getPiSessionBinding(LEGACY_DEFAULT_CONVERSATION_ID)
    ) {
      return;
    }
    if (!existing) {
      // Unreachable: a non-empty legacy chat always yields a conversation row.
      return;
    }

    const sessionManager = SessionManager.create(this.paths.repoRoot, this.paths.piSessionsDir);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error('Pi did not allocate a session file for the default conversation.');
    }
    const entries: SyncConversationEntry[] = [];
    let previousEntryId: string | null = null;
    for (const message of state.chat) {
      const piEntryId = sessionManager.appendMessage({
        role: message.role,
        content: message.content,
      } as any);
      entries.push({
        piEntryId,
        parentPiEntryId: previousEntryId,
        entryType: 'message',
        role: message.role,
        text: message.content,
        createdAt: message.createdAt,
        modelId: message.modelId,
        modelRuntimeId: message.modelRuntimeId,
        modelAliasSnapshot: message.modelAliasSnapshot,
        performance: message.performance,
        toolCalls: message.toolCalls,
        regeneratesPiEntryId: message.regeneratesPiEntryId,
        displayGroupId: message.displayGroupId,
      });
      previousEntryId = piEntryId;
    }
    await ensureSessionFile(sessionFile, sessionManager);
    this.conversations.replaceConversationProjection(LEGACY_DEFAULT_CONVERSATION_ID, {
      piSessionPath: sessionFile,
      piSessionId: sessionManager.getSessionId(),
      activeLeafPiEntryId: sessionManager.getLeafId(),
      lastSyncedPiEntryId: previousEntryId,
      status: existing.status,
      entries,
    });
  }

  /**
   * Re-checks an `unavailable` conversation's Pi session file.
   *
   * The only way back to `ready` is the file becoming readable again -- the user
   * restored it from a backup, or remounted the disk it lived on. If it is still
   * missing this throws rather than quietly writing a replacement under the same
   * conversation id; losing a session silently is exactly what this status
   * exists to prevent. `rebuildConversationFromProjection` is the explicit,
   * user-initiated way to move forward without the file.
   */
  async repairConversation(conversationId: string): Promise<ConversationSnapshot> {
    const row = this.conversations.getConversation(conversationId);
    if (!row) {
      throw new ConversationNotFoundError();
    }
    const issue = await this.conversations.getPiSessionIssue(conversationId);
    if (issue) {
      throw new SessionUnavailableError(issue, row.pi_session_path ?? undefined);
    }
    if (row.status === 'unavailable') {
      this.conversations.setConversationStatus(conversationId, 'ready');
    }
    const snapshot = await this.getConversationSnapshot(conversationId);
    if (!snapshot) {
      throw new ConversationNotFoundError();
    }
    return snapshot;
  }

  /**
   * Writes a fresh Pi session from Nelle's own projection rows.
   *
   * `conversation_entry_projection.text_preview` is misnamed: it holds the whole
   * message, so SQLite can reconstruct the conversation llama.cpp and Pi lost.
   * The rebuild is lossy in ways the caller must have already warned about:
   * tool-call results and image content never reach the new entries, compaction
   * summaries cannot be expressed through `appendMessage`, and only the active
   * branch survives, so regenerate variants are dropped.
   *
   * The corrupt file is left on disk. It is the only remaining copy of whatever
   * could not be recovered, and the diagnostics endpoint names its path.
   */
  async rebuildConversationFromProjection(conversationId: string): Promise<ConversationSnapshot> {
    const row = this.conversations.getConversation(conversationId);
    if (!row) {
      throw new ConversationNotFoundError();
    }

    const source = this.conversations
      .getActivePathEntries(conversationId)
      // Pi's append API takes messages. A compaction summary is not one, so the
      // rebuilt session keeps the messages that survived compaction and loses
      // the summary that explains the gap.
      .filter(entry => entry.entryType === 'message' && entry.role != null);

    this.#sessions.get(conversationId)?.session.dispose?.();
    this.#sessions.delete(conversationId);
    this.#activeRuns.delete(conversationId);

    await fs.mkdir(this.paths.piSessionsDir, {recursive: true});
    const sessionManager = SessionManager.create(this.paths.repoRoot, this.paths.piSessionsDir);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error('Pi did not allocate a session file for the rebuilt conversation.');
    }

    const entries: SyncConversationEntry[] = [];
    const entryIdMapping = new Map<string, string>();
    let previousEntryId: string | null = null;
    for (const entry of source) {
      const piEntryId = sessionManager.appendMessage({
        role: entry.role,
        content: entry.textPreview ?? '',
      } as any) as string;
      entryIdMapping.set(entry.piEntryId, piEntryId);
      entries.push({
        piEntryId,
        parentPiEntryId: previousEntryId,
        entryType: 'message',
        role: entry.role,
        text: entry.textPreview ?? '',
        createdAt: entry.createdAt,
        modelId: entry.modelId,
        modelRuntimeId: entry.modelRuntimeId,
        modelAliasSnapshot: entry.modelAliasSnapshot,
        performance: entry.performance,
        toolCalls: entry.toolCalls,
        attachmentSummary: entry.attachmentSummary,
        reasoning: entry.reasoning,
        // The branch is linear again, so nothing regenerates anything.
        displayGroupId: piEntryId,
      });
      previousEntryId = piEntryId;
    }

    await ensureSessionFile(sessionFile, sessionManager);
    // Sidecar rows key off Pi entry ids, and every one of them just changed.
    this.conversations.remapAttachmentEntryIds(conversationId, entryIdMapping);
    this.conversations.replaceConversationProjection(conversationId, {
      piSessionPath: sessionFile,
      piSessionId: sessionManager.getSessionId(),
      activeLeafPiEntryId: sessionManager.getLeafId(),
      lastSyncedPiEntryId: previousEntryId,
      status: 'ready',
      entries,
    });

    const snapshot = await this.getConversationSnapshot(conversationId);
    if (!snapshot) {
      throw new ConversationNotFoundError();
    }
    return snapshot;
  }

  async getConversationSnapshot(conversationId: string): Promise<ConversationSnapshot | null> {
    if (conversationId === LEGACY_DEFAULT_CONVERSATION_ID) {
      this.conversations.syncLegacyDefaultConversationFromState(await this.store.getState());
    }
    const row = this.conversations.getConversation(conversationId);
    if (!row) {
      return null;
    }
    const checked = await this.conversations.markUnavailableIfPiSessionInvalid(conversationId);
    if (checked?.status === 'unavailable' || row.status === 'unavailable') {
      return this.conversations.getSnapshot(conversationId, await this.store.getState());
    }
    if (this.#activeRuns.has(conversationId)) {
      return this.conversations.getSnapshot(conversationId, await this.store.getState());
    }
    const binding = this.conversations.getPiSessionBinding(conversationId);
    if (binding?.piSessionPath) {
      const sessionManager = SessionManager.open(
        binding.piSessionPath,
        this.paths.piSessionsDir,
        this.paths.repoRoot,
      );
      const activeModel = await this.getProjectionModel();
      this.syncPiConversation(
        conversationId,
        {
          sessionFile: binding.piSessionPath,
          sessionId: sessionManager.getSessionId(),
          sessionManager,
        },
        activeModel,
        undefined,
        'ready',
      );
    }
    return this.conversations.getSnapshot(conversationId, await this.store.getState());
  }

  async abortConversation(conversationId: string): Promise<AbortConversationResult> {
    const run = this.#activeRuns.get(conversationId);
    if (run) {
      return this.abortConversationRun(conversationId, run.runId);
    }
    return {aborted: false};
  }

  async abortConversationRun(
    conversationId: string,
    runId: string,
  ): Promise<AbortConversationResult> {
    const run = this.#activeRuns.get(conversationId);
    if (!run || run.runId !== runId) {
      return {aborted: false};
    }
    run.abortRequested = true;
    if (run.kind === 'title') {
      run.abortController?.abort();
      return {aborted: true};
    }
    const managed = this.#sessions.get(conversationId);
    if (!managed) {
      this.conversations.setConversationStatus(conversationId, 'aborting');
      return {aborted: true};
    }
    this.conversations.setConversationStatus(conversationId, 'aborting');
    await abortSessionRetry(managed.session);
    if (run.kind === 'compact') {
      managed.session.abortCompaction?.();
    } else {
      await managed.session.abort?.();
    }
    await abortSessionRetry(managed.session);
    run.abortWarning = await this.verifyLlamaAbortIdle(run);
    return {
      aborted: true,
      warning: run.abortWarning,
    };
  }

  async compactConversation(
    conversationId: string,
    customInstructions?: string,
  ): Promise<{compacted: boolean}> {
    // Compact the conversation with the conversation's own model, or it would
    // summarize a chat using a model that never wrote a word of it.
    const activeModel = await resolveConversationModel(
      this.conversations,
      this.store,
      conversationId,
    );
    if (!activeModel) {
      throw new Error('Select a model before compacting conversation context.');
    }
    return await this.runCompactConversation(conversationId, activeModel, customInstructions);
  }

  async streamCompactConversation(
    conversationId: string,
    customInstructions?: string,
  ): Promise<AsyncIterable<ChatStreamEvent>> {
    const queue = createAsyncQueue<ChatStreamEvent>();
    void (async () => {
      try {
        const activeModel = await resolveConversationModel(
          this.conversations,
          this.store,
          conversationId,
        );
        if (!activeModel) {
          throw new Error('Select a model before compacting conversation context.');
        }
        await this.runCompactConversation(conversationId, activeModel, customInstructions, queue);
      } catch (error) {
        queue.push(createErrorEvent(error, {fallbackCode: 'compact_failed'}));
      } finally {
        queue.end();
      }
    })();
    return queue;
  }

  private async runCompactConversation(
    conversationId: string,
    activeModel: ConfiguredModel,
    customInstructions?: string,
    queue?: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
  ): Promise<{compacted: boolean}> {
    this.conversations.ensureConversation(conversationId, {
      defaultModelId: activeModel.id,
    });
    await this.assertConversationSessionAvailable(conversationId);
    const run = this.beginRun(conversationId, 'compact', activeModel.id);
    this.conversations.setConversationStatus(conversationId, 'compacting');
    queue?.push(createRunStartedEvent(run));
    queue?.push(createCompactStartedEvent(run, customInstructions));
    try {
      const session = await this.ensureSession(conversationId, activeModel);
      if (run.abortRequested) {
        pushRunAbortedEvents(queue, run);
        return {compacted: false};
      }
      if ((session.messages?.length ?? 0) === 0) {
        throw new Error('There is no conversation context to compact.');
      }
      await session.compact(customInstructions?.trim() || undefined);
      const syncedEntries = this.syncPiConversation(
        conversationId,
        session,
        activeModel,
        undefined,
        'compacting',
      );
      if (run.abortRequested) {
        pushRunAbortedEvents(queue, run);
        return {compacted: false};
      }
      const context = await this.updateCompactedContextUsage(
        conversationId,
        syncedEntries,
        activeModel,
      );
      if (context) {
        queue?.push(createContextUpdatedEvent(conversationId, context));
      }
      queue?.push(createCompactCompletedEvent(run));
      queue?.push(createRunCompletedEvent(run, 'completed'));
      return {compacted: true};
    } catch (error) {
      if (run.abortRequested) {
        pushRunAbortedEvents(queue, run);
        return {compacted: false};
      }
      const runError = {
        code: isSessionUnavailableError(error) ? 'session_unavailable' : 'compact_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: !isSessionUnavailableError(error),
      };
      queue?.push(createCompactFailedEvent(run, runError));
      queue?.push(createRunCompletedEvent(run, 'failed', runError));
      throw error;
    } finally {
      this.finishRun(conversationId, run.runId);
      this.setConversationReadyUnlessUnavailable(conversationId);
    }
  }

  private async updateCompactedContextUsage(
    conversationId: string,
    entries: SyncConversationEntry[],
    activeModel: ConfiguredModel,
  ): Promise<ConversationContextUsage | null> {
    if (!this.llamaRuntime?.tokenize) {
      return null;
    }
    const content = renderContextEstimateInput(entries);
    if (!content) {
      return null;
    }
    try {
      const result = await this.llamaRuntime.tokenize(content);
      const context: ConversationContextUsage = {
        usedTokens: result.tokens,
        totalTokens: this.contextWindow(activeModel) ?? undefined,
        source: 'estimate',
        updatedAt: new Date().toISOString(),
      };
      this.conversations.setConversationContextUsage(conversationId, context);
      return context;
    } catch {
      return null;
    }
  }

  abortCompaction(conversationId: string): boolean {
    const run = this.#activeRuns.get(conversationId);
    if (run?.kind === 'compact') {
      run.abortRequested = true;
    }
    const managed = this.#sessions.get(conversationId);
    if (!managed) {
      return run?.kind === 'compact';
    }
    managed.session.abortCompaction?.();
    this.conversations.setConversationStatus(conversationId, 'ready');
    return true;
  }

  private async verifyLlamaAbortIdle(run: ActiveRun): Promise<NelleError | undefined> {
    if (!this.llamaRuntime?.verifyAbortIdle || !run.modelId) {
      return undefined;
    }
    try {
      return (await this.llamaRuntime.verifyAbortIdle({modelId: run.modelId})).warning;
    } catch {
      return undefined;
    }
  }

  async streamPrompt(
    prompt: string,
    conversationId = 'legacy-default',
    attachments: ChatAttachmentInput[] = [],
  ): Promise<AsyncIterable<ChatStreamEvent>> {
    // The conversation's own model, not whatever is globally active -- see
    // resolveConversationModel. A brand-new conversation has none yet, so this
    // returns the active model, which `ensureConversation` then stamps it with.
    const activeModel = await resolveConversationModel(
      this.conversations,
      this.store,
      conversationId,
    );
    if (!activeModel) {
      throw new Error('Select a model before chatting.');
    }

    this.conversations.ensureConversation(conversationId, {
      title: prompt.slice(0, 80) || 'New chat',
      defaultModelId: activeModel.id,
    });
    await this.assertConversationSessionAvailable(conversationId);
    const promptAttachments = await this.preparePromptAttachments(
      conversationId,
      attachments,
      activeModel,
    );
    const run = this.beginRun(conversationId, 'chat', activeModel.id);
    this.conversations.setConversationStatus(conversationId, 'running');

    const queue = createAsyncQueue<ChatStreamEvent>();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      attachments: promptAttachments.metadata,
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

    queue.push(createRunStartedEvent(run));
    queue.push({type: 'message.user.created', message: userMessage});
    queue.push({type: 'message.assistant.started', message: assistantMessage, harness: 'pi'});

    void this.runPiPrompt(activeModel, conversationId, prompt, assistantMessage, queue, {
      run,
      promptAttachments,
    }).catch(error => {
      this.setConversationReadyUnlessUnavailable(conversationId);
      queue.push(createErrorEvent(error, {fallbackCode: 'pi_run_failed', retryable: true}));
      queue.end();
    });

    return queue;
  }

  async regenerateMessage(input: {
    conversationId: string;
    assistantMessageId: string;
    modelId?: string;
  }): Promise<AsyncIterable<ChatStreamEvent>> {
    // An explicit override wins (a footer model change); otherwise regenerate on the
    // conversation's own model. Must match how server.ts picked the model to load, or
    // the run loads one model and answers with another.
    const activeModel = input.modelId
      ? await this.store.getModel(input.modelId)
      : await resolveConversationModel(this.conversations, this.store, input.conversationId);
    if (!activeModel) {
      throw new Error(
        input.modelId ? `Unknown model: ${input.modelId}` : 'Select a model before regenerating.',
      );
    }
    await this.assertConversationSessionAvailable(input.conversationId);

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
    const sourceAttachments = await this.loadAttachmentInputsForEntry(
      input.conversationId,
      source.userEntry.piEntryId,
    );
    const promptAttachments = await this.preparePromptAttachments(
      input.conversationId,
      sourceAttachments,
      activeModel,
    );

    const run = this.beginRun(input.conversationId, 'regenerate', activeModel.id);
    this.conversations.setConversationStatus(input.conversationId, 'running');
    const queue = createAsyncQueue<ChatStreamEvent>();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      attachments: promptAttachments.metadata,
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

    queue.push(createRunStartedEvent(run));
    queue.push({type: 'message.user.created', message: userMessage});
    queue.push({type: 'message.assistant.started', message: assistantMessage, harness: 'pi'});

    void this.runPiPrompt(activeModel, input.conversationId, prompt, assistantMessage, queue, {
      run,
      branchFromPiEntryId: source.branchFromPiEntryId,
      regeneratesPiEntryId: source.regeneratesPiEntryId,
      displayGroupId: source.displayGroupId,
      promptAttachments,
    }).catch(error => {
      this.setConversationReadyUnlessUnavailable(input.conversationId);
      queue.push(createErrorEvent(error, {fallbackCode: 'pi_run_failed', retryable: true}));
      queue.end();
    });

    return queue;
  }

  async forkConversation(input: {
    conversationId: string;
    entryId: string;
    title?: string;
  }): Promise<ConversationSnapshot> {
    return this.createBranchedConversation({
      conversationId: input.conversationId,
      entryId: input.entryId,
      title: input.title,
      kind: 'fork',
    });
  }

  async cloneConversation(input: {
    conversationId: string;
    entryId?: string;
    title?: string;
  }): Promise<ConversationSnapshot> {
    return this.createBranchedConversation({
      conversationId: input.conversationId,
      entryId: input.entryId,
      title: input.title,
      kind: 'clone',
    });
  }

  private async runPiPrompt(
    activeModel: ConfiguredModel,
    conversationId: string,
    prompt: string,
    assistantMessage: ChatMessage,
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
    options: {
      run: ActiveRun;
      branchFromPiEntryId?: string | null;
      regeneratesPiEntryId?: string;
      displayGroupId?: string;
      promptAttachments?: PreparedPromptAttachments;
    },
  ): Promise<void> {
    const run = options.run;
    const session = await this.ensureSession(conversationId, activeModel);
    if (run.abortRequested) {
      pushRunAbortedEvents(queue, run);
      this.finishRun(conversationId, run.runId);
      this.setConversationReadyUnlessUnavailable(conversationId);
      queue.end();
      return;
    }
    if (options.branchFromPiEntryId !== undefined) {
      if (options.branchFromPiEntryId === null) {
        session.sessionManager.resetLeaf();
      } else {
        session.sessionManager.branch(options.branchFromPiEntryId);
      }
    }
    // Pi clamps to the model's capabilities and records a `thinking_level_change`
    // entry in the session file, so a cached session picks up an on-the-fly change.
    const reasoningLevel = this.conversations.getReasoningLevel(conversationId);
    session.setThinkingLevel?.(piThinkingLevel(reasoningLevel));
    const state = await this.store.getState();
    let warnedAboutReplyBudget = false;
    const trackContext = createLiveContextTracker(this.contextWindow(activeModel) ?? undefined);
    const pushPerformance = (performance: ChatPerformance) => {
      assistantMessage.performance = mergeChatPerformance(
        assistantMessage.performance,
        performance,
      );
      // The context bar follows the run, rather than waiting for compaction.
      const context = trackContext(assistantMessage.performance);
      if (context) {
        queue.push(createContextUpdatedEvent(conversationId, context));
      }
      // Pi silently clamps max_tokens to 1 once the prompt plus its 4k safety
      // reserve fills the context window, which looks like a one-word answer.
      // Say so, instead of letting the user guess.
      const promptTokens =
        assistantMessage.performance.prompt?.totalTokens ??
        assistantMessage.performance.prompt?.tokens;
      const contextSize = this.contextWindow(activeModel);
      if (
        !warnedAboutReplyBudget &&
        promptTokens != null &&
        contextSize != null &&
        isReplyBudgetExhausted(contextSize, promptTokens)
      ) {
        warnedAboutReplyBudget = true;
        queue.push({
          type: 'run.warning',
          code: NELLE_WARNING_CODES.replyBudgetExhausted,
          message:
            `This prompt uses ${promptTokens.toLocaleString()} of the model's ` +
            `${contextSize.toLocaleString()} token context window, which leaves no room for a ` +
            `reply. Raise the context size to at least ` +
            `${minimumUsableContextSize(promptTokens).toLocaleString()} in Settings > Models.`,
        });
      }
      queue.push({
        type: 'performance.updated',
        id: assistantMessage.id,
        performance: assistantMessage.performance,
      });
    };
    const capture = beginLlamaPerformanceCapture(pushPerformance);
    // Pi clamps `max_tokens` against its own context estimate, which charges
    // 1,200 tokens per image. When it clamps to 1 the turn cannot produce an
    // answer, and only the proxy ever sees the number.
    let lastRequestedMaxTokens: number | undefined;
    const requestCapture = beginLlamaRequestCapture(info => {
      lastRequestedMaxTokens = info.maxTokens;
      const squeezed = squeezedReplyBudgetWarning(info.maxTokens);
      if (squeezed && !warnedAboutReplyBudget) {
        warnedAboutReplyBudget = true;
        queue.push({
          type: 'run.warning',
          code: NELLE_WARNING_CODES.replyBudgetExhausted,
          message: squeezed,
        });
      }
    });
    const monitor = startLlamaThroughputMonitor({
      port: state.runtime.port,
      modelId: llamaRuntimeModelId(activeModel),
      onPerformance: pushPerformance,
    });
    const toolCalls: ToolCallEvent[] = [];
    let toolsDisabledAborted = false;
    const toolCallStarts = new Map<string, number>();
    let thinkingText = '';
    let providerError: string | null = null;
    let resourcesStopped = false;
    const answerFilter = createThinkingEndTagFilter();
    const pushAnswerText = (text: string) => {
      if (!text) {
        return;
      }
      assistantMessage.content += text;
      queue.push({
        type: 'message.assistant.delta',
        id: assistantMessage.id,
        delta: text,
        isReasoning: false,
      });
    };
    const unsubscribe = session.subscribe((event: any) => {
      // `tools: []` at session construction is a build-time gate, not a runtime
      // one. A cached session, a Pi retry, or a future Pi version could still
      // emit a tool event; the user disabling host tools mid-run certainly can.
      // Fail closed: no audit row, no tool event, and the run ends.
      if (isToolExecutionEvent(event.type) && !this.hostTools.areToolsEnabled()) {
        if (!toolsDisabledAborted) {
          toolsDisabledAborted = true;
          queue.push(createErrorEvent(new ToolsDisabledError()));
          void session.abort?.();
        }
        return;
      }
      if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === 'text_delta') {
          pushAnswerText(answerFilter.push(String(assistantEvent.delta ?? '')));
        }
        if (assistantEvent?.type === 'thinking_delta') {
          const delta = String(assistantEvent.delta ?? '');
          thinkingText += delta;
          assistantMessage.reasoning = thinkingText;
          queue.push({
            type: 'message.assistant.reasoning_delta',
            id: assistantMessage.id,
            delta,
            isReasoning: true,
          });
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
        const startedAt = Date.now();
        const call: ToolCallEvent = {
          id,
          name: String(event.toolName ?? 'tool'),
          target: summarizeToolTarget(event.toolName, event.args),
          status: 'running',
          input: stringifyToolData(event.args),
        };
        toolCallStarts.set(id, startedAt);
        this.hostTools.recordToolStart({
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
        this.hostTools.recordToolEnd({
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
    });
    const stopPromptResources = () => {
      if (resourcesStopped) {
        return;
      }
      // Release any answer bytes still held by the end-tag filter, so an abort
      // or a provider error does not silently swallow the start of the reply.
      pushAnswerText(answerFilter.flush());
      resourcesStopped = true;
      monitor.stop();
      capture.stop();
      requestCapture.stop();
      unsubscribe();
    };

    try {
      const promptAttachments = options.promptAttachments ?? emptyPreparedAttachments();
      await session.prompt(buildPiPrompt(prompt, promptAttachments.items), {
        images: promptAttachments.items.map(item => item.image).filter(item => item != null),
      });
      pushAnswerText(answerFilter.flush());
      assistantMessage.toolCalls = toolCalls;
      if (!assistantMessage.content.trim()) {
        const fallback = thinkingText.trim();
        if (!fallback) {
          throw emptyAnswerError({
            providerError: providerError ?? undefined,
            maxTokens: lastRequestedMaxTokens,
            contextSize: this.contextWindow(activeModel),
            imageCount: promptAttachments.items.filter(item => item.image).length,
          });
        }
        if (isReasoningEnabled(reasoningLevel)) {
          // The transcript already renders the thinking block, so promoting it
          // to the answer would show the same text twice.
          queue.push({
            type: 'run.warning',
            code: NELLE_WARNING_CODES.reasoningBudgetExhausted,
            message:
              'The model spent its whole reasoning budget without answering. Raise the ' +
              `${reasoningLevel} budget in Settings > Reasoning, or lower the reasoning level.`,
          });
        } else {
          queue.push({
            type: 'run.warning',
            code: NELLE_WARNING_CODES.reasoningWithoutAnswer,
            message:
              'The model returned reasoning content without final text; showing the reasoning output.',
          });
          assistantMessage.content = fallback;
          queue.push({
            type: 'message.assistant.delta',
            id: assistantMessage.id,
            delta: fallback,
            isReasoning: false,
          });
        }
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
          userPromptText: prompt,
          userAttachmentSummary: summarizePreparedAttachments(promptAttachments.metadata),
        },
      );
      const userEntry = findPromptUserEntry(syncedEntries, assistantMessage);
      if (userEntry && promptAttachments.uploadIds.length > 0) {
        this.conversations.bindAttachmentsToEntry(
          conversationId,
          promptAttachments.uploadIds,
          userEntry.piEntryId,
        );
      }
      queue.push({type: 'message.assistant.completed', message: assistantMessage});
      queue.push(createRunCompletedEvent(run, 'completed'));
      this.finishRun(conversationId, run.runId);
      this.setConversationReadyUnlessUnavailable(conversationId);
      stopPromptResources();
      await this.streamConversationTitleIfNeeded(conversationId, activeModel, syncedEntries, queue);
      queue.end();
    } catch (error) {
      if (run.abortRequested) {
        pushRunAbortedEvents(queue, run);
        queue.end();
        return;
      }
      queue.push(
        createRunCompletedEvent(run, 'failed', {
          code: isSessionUnavailableError(error) ? 'session_unavailable' : 'pi_run_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: !isSessionUnavailableError(error),
        }),
      );
      throw error;
    } finally {
      stopPromptResources();
      this.finishRun(conversationId, run.runId);
      this.setConversationReadyUnlessUnavailable(conversationId);
    }
  }

  private beginRun(
    conversationId: string,
    kind: RunKind,
    modelId?: string,
    abortController?: AbortController,
  ): ActiveRun {
    const existing = this.#activeRuns.get(conversationId);
    if (existing) {
      throw new Error('conversation_busy');
    }
    const run: ActiveRun = {
      runId: `run-${crypto.randomUUID()}`,
      conversationId,
      kind,
      modelId,
      abortRequested: false,
      abortController,
    };
    this.#activeRuns.set(conversationId, run);
    return run;
  }

  private finishRun(conversationId: string, runId: string): void {
    const existing = this.#activeRuns.get(conversationId);
    if (existing?.runId === runId) {
      this.#activeRuns.delete(conversationId);
    }
  }

  private async streamConversationTitleIfNeeded(
    conversationId: string,
    activeModel: ConfiguredModel,
    entries: SyncConversationEntry[],
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
  ): Promise<void> {
    const titleInput = this.titleGenerationInput(conversationId, entries);
    if (!titleInput) {
      return;
    }
    const settings = this.titleSettings();
    if (settings.mode === 'off') {
      // The conversation keeps "New chat", and `titleSource` stays `fallback`,
      // so turning the setting back on retitles it on the next first turn.
      return;
    }
    if (settings.mode === 'first-line' || titleInput.assistantResponse === null) {
      // No model, no round trip, no run: nothing ran. `llm` lands here too when
      // the model answered with nothing, because there is no reply to summarize
      // and a request that says so would only waste a load.
      this.applyFirstLineTitle(conversationId, titleInput.userPrompt, settings, queue);
      return;
    }
    const assistantResponse = titleInput.assistantResponse;

    const abortController = new AbortController();
    let run: ActiveRun;
    try {
      run = this.beginRun(conversationId, 'title', activeModel.id, abortController);
    } catch (error) {
      if (error instanceof Error && error.message === 'conversation_busy') {
        return;
      }
      throw error;
    }
    queue.push(createRunStartedEvent(run));
    try {
      const title = await this.generateTitleWithLlama(
        activeModel,
        titleInput.userPrompt,
        assistantResponse,
        settings,
        abortController.signal,
      );
      if (run.abortRequested || abortController.signal.aborted) {
        queue.push(createRunAbortedEvent(run, 'user'));
        queue.push(createRunCompletedEvent(run, 'aborted'));
        return;
      }
      if (title) {
        this.conversations.setGeneratedTitle(conversationId, title);
        queue.push(createConversationTitleEvent(conversationId, title));
      } else {
        // The request failed, timed out, or came back with nothing usable. A
        // first line is a worse title than the model's, and a better one than
        // "New chat" forever.
        this.applyFirstLineTitle(conversationId, titleInput.userPrompt, settings, queue);
      }
      queue.push(createRunCompletedEvent(run, 'completed'));
    } catch (error) {
      if (run.abortRequested || abortController.signal.aborted) {
        queue.push(createRunAbortedEvent(run, 'user'));
        queue.push(createRunCompletedEvent(run, 'aborted'));
        return;
      }
      queue.push(
        createRunCompletedEvent(run, 'failed', {
          code: 'title_generation_failed',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        }),
      );
    } finally {
      this.finishRun(conversationId, run.runId);
      this.conversations.setConversationStatus(conversationId, 'ready');
    }
  }

  private applyFirstLineTitle(
    conversationId: string,
    userPrompt: string,
    settings: TitleSettings,
    queue: ReturnType<typeof createAsyncQueue<ChatStreamEvent>>,
  ): void {
    const title = firstLineTitle(userPrompt, settings.maxWords);
    if (!title) {
      return;
    }
    // `setGeneratedTitle` refuses a conversation the user has named, so a race
    // with a rename cannot overwrite it.
    if (this.conversations.setGeneratedTitle(conversationId, title)) {
      queue.push(createConversationTitleEvent(conversationId, title));
    }
  }

  /**
   * Pi's OpenAI-completions provider only ever sends
   * `chat_template_kwargs.enable_thinking`; its `thinkingBudgets` setting is
   * read by the Anthropic and Google providers alone. llama.cpp caps a thinking
   * block from the top-level `thinking_budget_tokens` field, so inject it into
   * the outgoing payload through Pi's own per-session payload hook.
   */
  private attachReasoningBudget(conversationId: string, session: any): void {
    const agent = session.agent;
    if (!agent) {
      return;
    }
    const previous = agent.onPayload?.bind(agent);
    agent.onPayload = async (payload: unknown, model: unknown) => {
      const next = (await previous?.(payload, model)) ?? payload;
      // The budgets are a settings group now, not a corner of `state.json`: the settings
      // screen and this read the same row, and the group renders itself from the schema.
      const budget = reasoningBudgetTokens(
        this.conversations.getReasoningLevel(conversationId),
        reasoningBudgetsFromSettings(this.settings?.tryGetGroup(REASONING_SETTINGS_SLUG) ?? {}),
      );
      if (budget == null || next == null || typeof next !== 'object') {
        return next;
      }
      return {...(next as Record<string, unknown>), thinking_budget_tokens: budget};
    };
  }

  private async ensureSession(conversationId: string, activeModel: ConfiguredModel): Promise<any> {
    const cached = this.#sessions.get(conversationId);
    // Not just the model: a session created before llama.cpp first reported this
    // model's window clamps against the old number for its whole life.
    const contextWindow = requireContextWindow(activeModel, this.modelCache);
    if (cached && cached.modelId === activeModel.id && cached.contextWindow === contextWindow) {
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

    const toolsEnabled = this.hostTools.areToolsEnabled();
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.paths.repoRoot,
      agentDir: this.paths.piDir,
      systemPromptOverride: () => nelleOperationalPrompt(toolsEnabled),
      // Appended, never substituted. Replacing the operational prompt with user
      // text would delete the sentence that tells the model host tools run
      // unsandboxed as the launching OS user.
      appendSystemPromptOverride: () => appendedSystemPrompts(this.customInstructions()),
    });
    await resourceLoader.reload();

    await fs.mkdir(this.paths.piSessionsDir, {recursive: true});
    await this.assertConversationSessionAvailable(conversationId);
    const binding = this.conversations.getPiSessionBinding(conversationId);
    const sessionManager = binding?.piSessionPath
      ? SessionManager.open(binding.piSessionPath, this.paths.piSessionsDir, this.paths.repoRoot)
      : SessionManager.create(this.paths.repoRoot, this.paths.piSessionsDir);

    const {session} = await createAgentSession({
      agentDir: this.paths.piDir,
      cwd: this.paths.repoRoot,
      model,
      thinkingLevel: piThinkingLevel(this.conversations.getReasoningLevel(conversationId)),
      tools: toolsEnabled ? TOOL_ALLOWLIST : [],
      authStorage,
      modelRegistry,
      resourceLoader,
      sessionManager,
    } as any);
    this.attachReasoningBudget(conversationId, session);

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
      contextWindow,
      session,
    });
    return session;
  }

  private async assertConversationSessionAvailable(conversationId: string): Promise<void> {
    const conversation = await this.conversations.markUnavailableIfPiSessionInvalid(conversationId);
    if (conversation?.status !== 'unavailable') {
      return;
    }
    this.#sessions.get(conversationId)?.session.dispose?.();
    this.#sessions.delete(conversationId);
    this.#activeRuns.delete(conversationId);
    throw new SessionUnavailableError();
  }

  private setConversationReadyUnlessUnavailable(conversationId: string): void {
    if (this.conversations.getConversation(conversationId)?.status === 'unavailable') {
      return;
    }
    this.conversations.setConversationStatus(conversationId, 'ready');
  }

  private async preparePromptAttachments(
    conversationId: string,
    attachments: ChatAttachmentInput[],
    activeModel: ConfiguredModel,
  ): Promise<PreparedPromptAttachments> {
    if (attachments.length === 0) {
      return emptyPreparedAttachments();
    }
    if (attachments.some(attachment => attachment.kind === 'image')) {
      await this.assertImageAttachmentsSupported(activeModel);
    }

    await fs.mkdir(this.paths.attachmentsDir, {recursive: true});
    const records = [];
    const prepared: Array<Omit<PreparedPromptAttachment, 'metadata'>> = [];
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        const image = decodeImageAttachment(attachment);
        const storagePath = await this.writeAttachmentBlob(image.buffer, image.mimeType);
        records.push({
          uploadId: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: image.mimeType,
          sizeBytes: attachment.sizeBytes ?? image.buffer.byteLength,
          storagePath,
          processing: {
            status: 'ready',
            source: 'chat-request',
            sha256: image.sha256,
          },
        });
        prepared.push({
          input: attachment,
          image: {
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          },
        });
        continue;
      }

      const text = (attachment.text ?? '').slice(0, ATTACHMENT_TEXT_INLINE_MAX);
      records.push({
        uploadId: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        textContent: text,
        processing: {
          status: 'ready',
          source: 'chat-request',
          truncated: (attachment.text?.length ?? 0) > text.length,
        },
      });
      prepared.push({
        input: attachment,
        text,
      });
    }

    const metadata = this.conversations.createPendingAttachments(conversationId, records);
    return {
      items: prepared.map((item, index) => ({
        ...item,
        metadata: metadata[index]!,
      })),
      metadata,
      uploadIds: attachments.map(attachment => attachment.id),
    };
  }

  /**
   * Refuses image attachments for a model that cannot see them.
   *
   * This used to `fetch` llama.cpp `/props` directly, behind the back of both the
   * `/api/llama` facade and `model_cache` -- a third implementation of a question
   * the cache exists to answer. It now asks the facade and records the answer, so
   * a later reader does not have to ask llama.cpp again.
   *
   * The behavior is unchanged: props that cannot be fetched are still an error,
   * because llama.cpp only answers for a model it has loaded at least once. Once
   * the server loads models itself, this whole method gives way to
   * `modelCache.getVisionSupport()`.
   */
  private async assertImageAttachmentsSupported(activeModel: ConfiguredModel): Promise<void> {
    const llamaRuntime = this.llamaRuntime;
    if (!llamaRuntime?.getModelProps) {
      throw new Error(
        'Could not verify image support for the selected model. Load the model before sending images.',
      );
    }

    let props: LlamaModelProps;
    try {
      // Called on the manager, not detached from it: `getModelProps` reaches for
      // `this.fetchRouterJson`, and an unbound call fails as if llama.cpp were
      // unreachable.
      props = await llamaRuntime.getModelProps(llamaRuntimeModelId(activeModel));
    } catch {
      throw new Error(
        'Could not verify image support for the selected model. Load the model before sending images.',
      );
    }

    this.modelCache?.upsertModelProps(activeModel.id, props);
    if (!props.modalities.vision) {
      throw new Error('Image attachments require a selected model with vision support.');
    }
  }

  private async writeAttachmentBlob(buffer: Buffer, mimeType: string): Promise<string> {
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const directory = path.join(this.paths.attachmentsDir, sha256.slice(0, 2));
    await fs.mkdir(directory, {recursive: true});
    const absolutePath = path.join(directory, `${sha256}${extensionForMimeType(mimeType)}`);
    try {
      await fs.writeFile(absolutePath, buffer, {flag: 'wx'});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    return relativeDataPath(this.paths.dataDir, absolutePath);
  }

  private async loadAttachmentInputsForEntry(
    conversationId: string,
    piEntryId: string,
  ): Promise<ChatAttachmentInput[]> {
    const stored = this.conversations.getStoredAttachmentsForEntry(conversationId, piEntryId);
    const inputs: ChatAttachmentInput[] = [];
    for (const attachment of stored) {
      if (attachment.kind === 'image') {
        if (!attachment.storagePath || !attachment.mimeType) {
          continue;
        }
        const absolutePath = resolveDataPath(this.paths.dataDir, attachment.storagePath);
        const buffer = await fs.readFile(absolutePath);
        inputs.push({
          id: crypto.randomUUID(),
          kind: 'image',
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes ?? buffer.byteLength,
          data: buffer.toString('base64'),
        });
        continue;
      }
      if (!attachment.textContent) {
        continue;
      }
      inputs.push({
        id: crypto.randomUUID(),
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        text: attachment.textContent,
      });
    }
    return inputs;
  }

  private async createBranchedConversation(input: {
    conversationId: string;
    entryId?: string;
    title?: string;
    kind: 'fork' | 'clone';
  }): Promise<ConversationSnapshot> {
    const source = this.conversations.getConversation(input.conversationId);
    if (!source) {
      throw new Error(`Conversation ${input.conversationId} was not found.`);
    }
    await this.assertConversationSessionAvailable(input.conversationId);
    const binding = this.conversations.getPiSessionBinding(input.conversationId);
    if (!binding?.piSessionPath) {
      throw new Error('This conversation does not have a Pi session to branch.');
    }

    const sourceManager = SessionManager.open(
      binding.piSessionPath,
      this.paths.piSessionsDir,
      this.paths.repoRoot,
    );
    const entryId = input.entryId ?? sourceManager.getLeafId();
    if (!entryId) {
      throw new Error('This conversation does not have a persisted entry to branch from.');
    }
    const entry = sourceManager.getEntry(entryId);
    if (!entry) {
      throw new Error(`Entry ${entryId} was not found in the Pi session.`);
    }
    if (input.kind === 'fork' && !isUserMessageEntry(entry)) {
      throw new Error('Forking is only available from persisted user messages.');
    }

    const branchedSessionPath = sourceManager.createBranchedSession(entryId);
    if (!branchedSessionPath) {
      throw new Error('Pi did not create a branched session file.');
    }
    await ensureSessionFile(branchedSessionPath, sourceManager);
    const branchedManager = SessionManager.open(
      branchedSessionPath,
      this.paths.piSessionsDir,
      this.paths.repoRoot,
    );
    const conversation = this.conversations.createConversation({
      title: input.title ?? `${source.title}${input.kind === 'fork' ? ' (fork)' : ' (copy)'}`,
      titleSource: 'fallback',
      defaultModelId: source.default_model_id,
      parentConversationId: source.id,
      forkedFromPiEntryId: entryId,
      forkKind: input.kind,
      reasoningLevel: this.conversations.getReasoningLevel(input.conversationId),
    });
    this.conversations.attachPiSession(conversation.id, {
      piSessionPath: branchedSessionPath,
      piSessionId: branchedManager.getSessionId(),
      activeLeafPiEntryId: branchedManager.getLeafId(),
    });

    const activeModel = await this.getProjectionModel();
    const seedEntries = this.conversations.getConversationEntries(input.conversationId);
    const fakeSession = {
      sessionFile: branchedSessionPath,
      sessionId: branchedManager.getSessionId(),
      sessionManager: branchedManager,
    };
    const syncedEntries = this.syncPiConversation(
      conversation.id,
      fakeSession,
      activeModel,
      undefined,
      'ready',
      {seedEntries},
    );
    this.conversations.copyAttachmentsForEntries(
      input.conversationId,
      conversation.id,
      syncedEntries.map(projection => projection.piEntryId),
    );
    const snapshot = this.conversations.getSnapshot(conversation.id, await this.store.getState());
    if (!snapshot) {
      throw new Error('Created conversation snapshot was not available.');
    }
    return snapshot;
  }

  private async getProjectionModel(): Promise<ConfiguredModel> {
    const state = await this.store.getState();
    const model = state.models.find(item => item.id === state.activeModelId) ?? state.models[0];
    return (
      model ?? {
        id: 'unknown',
        name: 'Unknown model',
        presetName: 'unknown',
        source: 'huggingface',
        params: {},
        createdAt: new Date().toISOString(),
      }
    );
  }

  private syncPiConversation(
    conversationId: string,
    session: any,
    activeModel: ConfiguredModel,
    assistantMessage?: ChatMessage,
    status: ConversationStatus = 'running',
    metadata: {
      regeneratesPiEntryId?: string;
      displayGroupId?: string;
      userPromptText?: string;
      userAttachmentSummary?: unknown;
      seedEntries?: ConversationEntryProjection[];
    } = {},
  ): SyncConversationEntry[] {
    const branch = session.sessionManager.getBranch() as any[];
    const existingEntries = new Map([
      ...(metadata.seedEntries ?? []).map(entry => [entry.piEntryId, entry] as const),
      ...this.conversations
        .getConversationEntries(conversationId)
        .map(entry => [entry.piEntryId, entry] as const),
    ]);
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
      const rawText = extractMessageText(entry.message);
      // Pi stores what llama.cpp emitted, echoed budget end tag and all.
      const text = role === 'assistant' ? stripLeadingThinkingEndTag(rawText) : rawText;
      const projection: SyncConversationEntry = {
        piEntryId: String(entry.id),
        parentPiEntryId: entry.parentId ?? null,
        entryType: entry.type,
        role,
        text,
        createdAt: String(entry.timestamp ?? new Date().toISOString()),
        displayGroupId: String(entry.id),
      };
      const existingEntry = existingEntries.get(projection.piEntryId);
      projection.performance = existingEntry?.performance;
      projection.toolCalls = existingEntry?.toolCalls;
      projection.attachmentSummary = existingEntry?.attachmentSummary;
      projection.regeneratesPiEntryId = existingEntry?.regeneratesPiEntryId;
      projection.displayGroupId = existingEntry?.displayGroupId ?? projection.displayGroupId;
      projection.reasoning = extractMessageThinking(entry.message) || existingEntry?.reasoning;
      projection.text = displayedUserText(role, text, existingEntry?.textPreview);
      if (role === 'assistant') {
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
        lastAssistant.reasoning = lastAssistant.reasoning ?? assistantMessage.reasoning;
        lastAssistant.regeneratesPiEntryId = metadata.regeneratesPiEntryId;
        lastAssistant.displayGroupId = metadata.displayGroupId ?? metadata.regeneratesPiEntryId;
      }
      const promptedUser = findPromptUserEntry(entries, assistantMessage);
      if (promptedUser) {
        promptedUser.text = metadata.userPromptText ?? promptedUser.text;
        promptedUser.attachmentSummary =
          metadata.userAttachmentSummary ?? promptedUser.attachmentSummary;
      }
    }

    if (metadata.regeneratesPiEntryId) {
      prependExistingVariantGroup(
        entries,
        existingEntries,
        metadata.regeneratesPiEntryId,
        metadata.displayGroupId,
      );
    } else {
      // A sync with no metadata -- a snapshot refresh, a restart -- rebuilds the
      // projection from `getBranch()`, which only walks the active path. Without
      // this, the very next snapshot read after a regenerate drops the older
      // answer and its prompt: the prompt is hidden as a replayed user turn, and
      // the transcript shows a bare reply. The branch entries carry the group ids
      // back from the projection, so the groups can be rediscovered from them.
      for (const entry of [...entries]) {
        if (entry.role === 'assistant' && entry.regeneratesPiEntryId) {
          prependExistingVariantGroup(
            entries,
            existingEntries,
            entry.regeneratesPiEntryId,
            entry.displayGroupId ?? undefined,
          );
        }
      }
    }

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

  /**
   * The first exchange of a conversation nobody has named, or `null`.
   *
   * `assistantResponse` is `null` when the model produced no text -- it spent its
   * whole reasoning budget, or the turn was refused. Only the `llm` mode needs
   * it: a title taken from the user's first line never did.
   */
  private titleGenerationInput(
    conversationId: string,
    entries: SyncConversationEntry[],
  ): {userPrompt: string; assistantResponse: string | null} | null {
    if (this.conversations.getTitleSource(conversationId) !== 'fallback') {
      return null;
    }
    const userMessages = entries.filter(entry => entry.role === 'user' && entry.text.trim());
    const assistantMessages = entries.filter(
      entry => entry.role === 'assistant' && entry.text.trim(),
    );
    // A second user turn means this is no longer the first exchange, and a second
    // assistant turn means a regenerate variant is in play.
    if (userMessages.length !== 1 || assistantMessages.length > 1) {
      return null;
    }
    return {
      userPrompt: userMessages[0]!.text,
      assistantResponse: assistantMessages[0]?.text ?? null,
    };
  }

  /**
   * Asks the model for a title. `null` when it could not, for any reason: this
   * path never throws, because a conversation with no title is not an error.
   *
   * It sets its own `temperature`, which no other code path here does. It talks
   * to `/chat/completions` directly rather than through Pi, so `models.ini`'s
   * sampling defaults do not reach it -- and that is correct, because a creative
   * temperature makes bad titles.
   */
  private async generateTitleWithLlama(
    activeModel: ConfiguredModel,
    userPrompt: string,
    assistantResponse: string,
    settings: TitleSettings,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const abortTitleRequest = () => controller.abort();
    if (signal?.aborted) {
      controller.abort();
    } else {
      signal?.addEventListener('abort', abortTitleRequest, {once: true});
    }
    try {
      const response = await fetch(`${localLlamaProxyBaseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        signal: controller.signal,
        body: JSON.stringify({
          model: llamaRuntimeModelId(activeModel),
          messages: [
            // The system message is not user-editable: it states the output
            // format Nelle then parses, and a user who broke it would get quotes
            // and preamble stored as the conversation's name.
            {role: 'system', content: TITLE_SYSTEM_PROMPT},
            {
              role: 'user',
              content: renderTitlePrompt(settings.prompt, {
                user: userPrompt,
                assistant: assistantResponse,
                maxWords: settings.maxWords,
              }),
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
        settings.maxWords,
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortTitleRequest);
    }
  }

  private async writePiModels(activeModel: ConfiguredModel): Promise<void> {
    await fs.mkdir(this.paths.piDir, {recursive: true});
    // Pi bakes `contextWindow` into a session at construction and clamps against
    // it for the session's life, so it must never see a number nobody believes.
    // The chat and regenerate routes load the model before this runs, which is
    // what makes the window known; the assertion states that invariant.
    const activeContextWindow = requireContextWindow(activeModel, this.modelCache);
    const state = await this.store.getState();
    const models = state.models.flatMap(model => {
      const contextWindow =
        model.id === activeModel.id ? activeContextWindow : this.contextWindow(model);
      // Never loaded and never capped. Omit it rather than invent a window: Pi
      // only looks up the model it is about to run, and that one is loaded.
      if (contextWindow == null) {
        return [];
      }
      return [
        {
          id: llamaRuntimeModelId(model),
          name: model.name,
          // Whether a model can actually think is decided by its chat template,
          // not by its name. Declaring `reasoning` unlocks Pi's thinking levels
          // for every model; a template that ignores `enable_thinking` just
          // answers normally. `templateSupportsThinking` gates the UI control.
          reasoning: true,
          input: ['text', 'image'],
          contextWindow,
          // Pi clamps this against the live context, so advertise a generous
          // ceiling instead of a flat 512-token cap that truncated long answers.
          maxTokens: replyTokenBudget(contextWindow),
          cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
          // Pi hides `xhigh` unless the model maps it, and Nelle's `max` level
          // maps onto it. The value is never sent: `supportsReasoningEffort` is
          // false.
          thinkingLevelMap: {xhigh: 'xhigh'},
          // Pi's name for "pass `chat_template_kwargs.enable_thinking`", which
          // is how Qwen3, Gemma 4, and every llama.cpp thinking template read it.
          compat: {thinkingFormat: 'qwen-chat-template' as const},
        },
      ];
    });

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

function emptyPreparedAttachments(): PreparedPromptAttachments {
  return {items: [], metadata: [], uploadIds: []};
}

function createRunStartedEvent(run: ActiveRun): ChatStreamEvent {
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

function createRunAbortedEvent(
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

function pushRunAbortedEvents(
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

function createRunCompletedEvent(
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

function createContextUpdatedEvent(
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

function createCompactStartedEvent(
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

function createCompactCompletedEvent(run: ActiveRun): ChatStreamEvent {
  return {
    type: 'compact.completed',
    runId: run.runId,
    conversationId: run.conversationId,
    compacted: true,
    createdAt: new Date().toISOString(),
  };
}

function createCompactFailedEvent(
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

function renderContextEstimateInput(entries: SyncConversationEntry[]): string {
  return entries
    .map(entry => {
      const text = entry.text.trim();
      if (!text) {
        return '';
      }
      const label = entry.entryType === 'compaction' ? 'summary' : (entry.role ?? entry.entryType);
      return `${label}: ${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function buildPiPrompt(prompt: string, attachments: PreparedPromptAttachment[]): string {
  const textAttachments = attachments.filter(item => item.text);
  if (textAttachments.length === 0) {
    return prompt;
  }
  const renderedAttachments = textAttachments
    .map(
      attachment =>
        `<attachment name="${escapeAttachmentAttribute(attachment.metadata.name)}" type="${
          attachment.metadata.kind
        }">\n${attachment.text}\n</attachment>`,
    )
    .join('\n\n');
  return `${prompt}\n\nAttached files:\n${renderedAttachments}`;
}

function summarizePreparedAttachments(attachments: AttachmentMetadata[]): unknown {
  if (attachments.length === 0) {
    return undefined;
  }
  return {
    count: attachments.length,
    items: attachments.map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}

function findPromptUserEntry(
  entries: SyncConversationEntry[],
  assistantMessage: ChatMessage,
): SyncConversationEntry | undefined {
  let assistantIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === 'assistant') {
      assistantIndex = index;
      if (!assistantMessage.content || entry.text === assistantMessage.content) {
        break;
      }
    }
  }
  if (assistantIndex < 0) {
    return undefined;
  }
  const assistantEntry = entries[assistantIndex];
  const parentId = assistantEntry?.parentPiEntryId;
  if (parentId) {
    const parent = entries.find(entry => entry.piEntryId === parentId);
    if (parent?.role === 'user') {
      return parent;
    }
  }
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (entries[index]?.role === 'user') {
      return entries[index];
    }
  }
  return undefined;
}

function decodeImageAttachment(attachment: ChatAttachmentInput): {
  data: string;
  mimeType: string;
  buffer: Buffer;
  sha256: string;
} {
  const parsed = parseImageData(attachment.data ?? '', attachment.mimeType);
  const buffer = Buffer.from(parsed.data, 'base64');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return {...parsed, buffer, sha256};
}

function parseImageData(
  value: string,
  fallbackMimeType?: string,
): {data: string; mimeType: string} {
  const dataUrlMatch = value.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {mimeType: dataUrlMatch[1]!, data: dataUrlMatch[2]!};
  }
  if (!fallbackMimeType?.startsWith('image/')) {
    throw new Error('Image attachments require an image MIME type.');
  }
  return {mimeType: fallbackMimeType, data: value};
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === 'image/png') {
    return '.png';
  }
  if (mimeType === 'image/webp') {
    return '.webp';
  }
  if (mimeType === 'image/gif') {
    return '.gif';
  }
  return '.jpg';
}

function relativeDataPath(dataDir: string, absolutePath: string): string {
  return path.relative(dataDir, absolutePath).split(path.sep).join('/');
}

function resolveDataPath(dataDir: string, relativePath: string): string {
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  const normalizedDataDir = path.resolve(dataDir);
  if (resolved !== normalizedDataDir && !resolved.startsWith(`${normalizedDataDir}${path.sep}`)) {
    throw new Error('Attachment path escaped the Nelle data directory.');
  }
  return resolved;
}

function escapeAttachmentAttribute(value: string): string {
  return value.replace(/[<&"]/g, character => {
    if (character === '<') {
      return '&lt;';
    }
    if (character === '&') {
      return '&amp;';
    }
    return '&quot;';
  });
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
    // A variant is off the active branch, so `getBranch()` never sees it again and this
    // row is the only copy left. Dropping its reasoning here -- as this did -- means
    // regenerating an answer silently destroys the thinking of the answer it branched
    // from, and a projection rebuild writes the loss back over the row.
    reasoning: entry.reasoning,
    regeneratesPiEntryId: entry.regeneratesPiEntryId ?? null,
    displayGroupId: entry.displayGroupId ?? entry.piEntryId,
  });
}

/**
 * Carries the answers a regenerate branched away from back into the projection.
 *
 * Exported for tests: a variant is off the active branch, so `getBranch()` will never
 * hand it back and the projection row is the last copy of it there is.
 */
/**
 * The text a turn should *display*, given what Pi holds and what the projection already
 * held.
 *
 * Pi's copy of a **user** turn is the *enriched* prompt: the typed text plus the
 * attachment payload the model was actually shown — `<attachment name="secret.txt">` with
 * the whole file inside it. The typed text exists only in the projection, where the run
 * put it (`metadata.userPromptText`), and it cannot be recovered from Pi afterwards.
 *
 * A metadata-less sync — every snapshot read, every restart — rebuilds from `getBranch()`
 * and would otherwise overwrite the typed text with Pi's copy, so the transcript would
 * show the user the contents of their own attachment pasted into their message. The
 * projection wins for user turns, and only for user turns: an assistant's text is Pi's.
 */
export function displayedUserText(
  role: string | null | undefined,
  piText: string,
  projectedText: string | undefined,
): string {
  return role === 'user' && projectedText != null ? projectedText : piText;
}

export function prependExistingVariantGroup(
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

/**
 * Pi stores llama.cpp's `reasoning_content` as `{type: 'thinking', thinking}`
 * content blocks alongside the answer text, so the session file stays the
 * source of truth for a conversation's thinking history.
 */
function extractMessageThinking(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as {content?: unknown}).content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(item => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const block = item as {type?: unknown; thinking?: unknown; redacted?: unknown};
      if (block.type !== 'thinking' || block.redacted === true) {
        return '';
      }
      return typeof block.thinking === 'string' ? block.thinking : '';
    })
    .filter(Boolean)
    .join('\n');
}

function isUserMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const data = entry as {type?: unknown; message?: {role?: unknown}};
  return data.type === 'message' && data.message?.role === 'user';
}

async function ensureSessionFile(sessionPath: string, manager: any): Promise<void> {
  try {
    await fs.access(sessionPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const header = manager.getHeader?.();
  const entries = manager.getEntries?.();
  if (!header || !Array.isArray(entries)) {
    throw new Error('Pi created an in-memory branch without readable session entries.');
  }

  await fs.mkdir(path.dirname(sessionPath), {recursive: true});
  const content = [header, ...entries].map(entry => JSON.stringify(entry)).join('\n');
  try {
    await fs.writeFile(sessionPath, `${content}\n`, {flag: 'wx'});
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Nelle's own system prompt, which replaces Pi's.
 *
 * It states whether host tools are enabled and, when they are, that they run
 * unsandboxed as the launching OS user. That sentence is why user text is
 * appended rather than substituted: llama.cpp's web UI calls its equivalent
 * "System Message" and lets it replace the prompt, and Nelle must not.
 */
export function nelleOperationalPrompt(toolsEnabled: boolean): string {
  return [
    'You are Nelle Agent, a local-first personal AI agent.',
    toolsEnabled
      ? 'You may use host file and shell tools when needed.'
      : 'Host file and shell tools are disabled in Nelle settings.',
    toolsEnabled
      ? 'Nelle runs host tools unsandboxed as the launching OS user, so be careful and explain destructive operations before running them.'
      : 'Do not claim that you can inspect files or run shell commands unless host tools are enabled.',
  ].join('\n');
}

/**
 * What Pi appends after the operational prompt. Empty instructions append
 * nothing at all -- not an empty string, which would put a blank section into
 * every prompt and cost a token to say nothing.
 */
export function appendedSystemPrompts(customInstructions: string): string[] {
  const text = customInstructions.trim();
  return text ? [text] : [];
}

function createConversationTitleEvent(conversationId: string, title: string): ChatStreamEvent {
  return {
    type: 'conversation.updated',
    conversationId,
    title,
    titleSource: 'generated',
    updatedAt: new Date().toISOString(),
  };
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

class SessionUnavailableError extends Error {
  readonly detail?: string;

  constructor(reason?: string, piSessionPath?: string) {
    super(
      reason
        ? `${reason} Restore the Pi session file, rebuild the conversation from its stored messages, or delete it.`
        : 'The conversation session is unavailable. Restore or import the Pi session file, or delete the conversation.',
    );
    this.name = 'SessionUnavailableError';
    this.detail = piSessionPath;
  }
}

/** `tool_execution_start`, `_update` and `_end` are the only tool events Pi emits. */
/**
 * Cancels a pending Pi retry before aborting the run itself.
 *
 * Pi's in-process `AgentSession.abortRetry()` returns `void`; its RPC client
 * returns a promise. `await` covers both shapes, where calling `.catch()` on the
 * void one throws a TypeError and takes the whole abort down with it. A retry
 * that cannot be cancelled must not stop the abort that follows.
 */
export async function abortSessionRetry(session: {abortRetry?: () => unknown}): Promise<void> {
  try {
    await session.abortRetry?.();
  } catch {
    // Best effort: the caller aborts the session next regardless.
  }
}

/**
 * A reply budget too small to finish a sentence, but not small enough to end the
 * turn empty. The answer will stop mid-thought, so say why before it does.
 * `null` when the budget is healthy, unknown, or clamped outright -- a clamp is
 * `emptyAnswerError`'s to explain, and warning about it as well would say the
 * same thing twice.
 */
export function squeezedReplyBudgetWarning(maxTokens: number | undefined): string | null {
  if (
    maxTokens == null ||
    isClampedReplyBudget(maxTokens) ||
    maxTokens >= MIN_USABLE_REPLY_TOKENS
  ) {
    return null;
  }
  return (
    `This prompt leaves only ${maxTokens.toLocaleString()} tokens for a reply. ` +
    'Attach fewer files, run /compact, or raise the context size in Settings > Models.'
  );
}

/**
 * Explains a turn that ended with no assistant text.
 *
 * The old message -- "check the llama.cpp model id and logs" -- was true of
 * nothing the user could act on. The common cause is Pi clamping `max_tokens` to
 * one because its context estimate charges 1,200 tokens for every image, so a
 * third image on the default 16,384-token window leaves no reply budget at all.
 */
export function emptyAnswerError(input: {
  providerError?: string;
  maxTokens?: number;
  /** `null` when llama.cpp has never reported a window and none is configured. */
  contextSize: number | null;
  imageCount: number;
}): Error {
  if (input.providerError) {
    return new Error(input.providerError);
  }
  if (!isClampedReplyBudget(input.maxTokens)) {
    return new Error(
      'The Pi harness completed without assistant text. Check the llama.cpp model id and logs.',
    );
  }

  // Pi clamped the reply, so it knew a window even where Nelle does not. Say
  // what happened without naming a number nobody measured.
  const window =
    input.contextSize == null
      ? "this model's context window"
      : `this model's ${input.contextSize.toLocaleString()} token context window`;
  const message =
    input.imageCount > 0
      ? `The ${input.imageCount === 1 ? 'image' : `${input.imageCount} images`} left no room for a ` +
        `reply: Pi charges about ${PI_ESTIMATED_IMAGE_TOKENS.toLocaleString()} tokens per image ` +
        `against ${window}, and reserves ${PI_CONTEXT_SAFETY_TOKENS.toLocaleString()} more. ` +
        'Attach fewer images, or raise the context size in Settings > Models.'
      : `The prompt left no room for a reply inside ${window}. Run /compact, or raise the ` +
        'context size in Settings > Models.';

  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.replyBudgetExhausted, retryable: false});
  return error;
}

export function isToolExecutionEvent(eventType: unknown): boolean {
  return typeof eventType === 'string' && eventType.startsWith('tool_execution_');
}

export class ToolsDisabledError extends Error {
  readonly code = 'tools_disabled';
  readonly retryable = false;

  constructor() {
    super(
      'Host tools are disabled, but the model tried to call one. The run was stopped. Enable host tools in Settings > Tools to allow it.',
    );
    this.name = 'ToolsDisabledError';
  }
}

class ConversationNotFoundError extends Error {
  readonly code = 'conversation_not_found';

  constructor() {
    super('Conversation not found.');
    this.name = 'ConversationNotFoundError';
  }
}

function isSessionUnavailableError(error: unknown): boolean {
  return error instanceof SessionUnavailableError;
}

export function isConversationNotFoundError(error: unknown): boolean {
  return error instanceof ConversationNotFoundError;
}
