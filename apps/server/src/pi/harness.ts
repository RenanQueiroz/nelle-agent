import fs from 'node:fs/promises';
import crypto from 'node:crypto';

import {SessionManager} from '@earendil-works/pi-coding-agent';

import {createAsyncQueue} from '../lib/asyncQueue';
import {beginLlamaRequestCapture} from '../llama/proxy';
import {
  beginLlamaPerformanceCapture,
  mergeChatPerformance,
  startLlamaThroughputMonitor,
} from '../llama/throughput';
import {localLlamaProxyBaseUrl} from '../llama/proxy';
import {chatTemplateKwargsForModel, llamaRuntimeModelId} from '../models/compat';
import {createErrorEvent} from '../http/errors';
import type {AppPaths} from '../lib/paths';
import {AppStore} from '../models/store';
import {resolveConversationModel} from '../conversations/model';
import {type ConversationRepository, type SyncConversationEntry} from '../conversations/repository';
import type {HostToolRepository} from './hostTools';
import type {ModelCacheRepository} from '../models/cache';
import type {SettingsRepository} from '../settings/repository';
import {effectiveContextWindow, requireContextWindow} from '../llama/contextWindow';
import {
  CUSTOM_INSTRUCTIONS_KEY,
  INSTRUCTIONS_SETTINGS_SLUG,
  TITLES_SETTINGS_SLUG,
} from '../contracts/settingsKeys.ts';
import {
  TITLE_SYSTEM_PROMPT,
  firstLineTitle,
  readTitleSettings,
  renderTitlePrompt,
  sanitizeGeneratedTitle,
  type TitleSettings,
} from '../contracts/titles.ts';
import type {
  ConversationContextUsage,
  ConversationEntryProjection,
  ConversationSnapshot,
  ConversationStatus,
  RunKind,
} from '../contracts/conversations.ts';
import type {ChatAttachmentInput} from '../contracts/contracts.ts';
import {isReplyBudgetExhausted, minimumUsableContextSize} from '../contracts/piContext.ts';
import {
  createThinkingEndTagFilter,
  isReasoningEnabled,
  piThinkingLevel,
} from '../contracts/reasoning.ts';
import type {
  AbortConversationResult,
  ChatMessage,
  ChatPerformance,
  ChatStreamEvent,
  ConfiguredModel,
  LlamaModelProps,
  ToolCallEvent,
} from '../lib/types';
import type {NelleError} from '../contracts/contracts.ts';
import {NELLE_WARNING_CODES} from '../contracts/contracts.ts';
import {createLiveContextTracker} from '../conversations/context';
import {
  ConversationNotFoundError,
  emptyAnswerError,
  isConversationNotFoundError,
  isSessionUnavailableError,
  notBranchableError,
  SessionUnavailableError,
  squeezedReplyBudgetWarning,
  ToolsDisabledError,
} from './errors.ts';
import {
  type ActiveRun,
  createCompactCompletedEvent,
  createCompactFailedEvent,
  createCompactStartedEvent,
  createContextUpdatedEvent,
  createConversationTitleEvent,
  createRunAbortedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  pushRunAbortedEvents,
} from './events.ts';
import {
  abortSessionRetry,
  appendedSystemPrompts,
  createPiSession,
  ensureSessionFile,
  nelleOperationalPrompt,
} from './session.ts';
import {createToolEventSubscriber} from './tools.ts';
import {
  buildPiPrompt,
  emptyPreparedAttachments,
  PiAttachments,
  type PreparedPromptAttachments,
  summarizePreparedAttachments,
} from './attachments.ts';
import {
  displayedUserText,
  findPromptUserEntry,
  prependExistingVariantGroup,
  syncPiConversation,
} from './projection.ts';
import {isToolExecutionEvent} from './toolCalls.ts';

// The harness is what `server.ts` and the tests import, so what it used to define it still
// hands out. Moving a symbol into a neighbouring module is an internal change, and a public
// surface that shifts under a refactor is the refactor's own bug.
export {
  abortSessionRetry,
  appendedSystemPrompts,
  displayedUserText,
  emptyAnswerError,
  isConversationNotFoundError,
  isToolExecutionEvent,
  nelleOperationalPrompt,
  prependExistingVariantGroup,
  squeezedReplyBudgetWarning,
  ToolsDisabledError,
};

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

type LlamaRuntimeServices = {
  tokenize?: (content: string) => Promise<{tokens: number}>;
  getModelProps?: (modelId: string) => Promise<LlamaModelProps>;
  verifyAbortIdle?: (input: {modelId?: string; graceMs?: number}) => Promise<{
    warning?: NelleError;
  }>;
};

export class PiHarness {
  #sessions = new Map<string, ManagedSession>();
  #activeRuns = new Map<string, ActiveRun>();

  /** The bytes a prompt carries: where they land, and whether the model can even see them. */
  readonly #attachments: PiAttachments;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly conversations: ConversationRepository,
    private readonly hostTools: HostToolRepository,
    private readonly llamaRuntime?: LlamaRuntimeServices,
    private readonly modelCache?: ModelCacheRepository,
    /** Absent only in tests that do not touch a setting; they get the defaults. */
    private readonly settings?: SettingsRepository,
  ) {
    this.#attachments = new PiAttachments(paths, conversations, llamaRuntime, modelCache);
  }

  private async preparePromptAttachments(
    conversationId: string,
    attachments: ChatAttachmentInput[],
    activeModel: ConfiguredModel,
  ): Promise<PreparedPromptAttachments> {
    return this.#attachments.preparePromptAttachments(conversationId, attachments, activeModel);
  }

  private async assertImageAttachmentsSupported(activeModel: ConfiguredModel): Promise<void> {
    return this.#attachments.assertImageAttachmentsSupported(activeModel);
  }

  private async loadAttachmentInputsForEntry(
    conversationId: string,
    piEntryId: string,
  ): Promise<ChatAttachmentInput[]> {
    return this.#attachments.loadAttachmentInputsForEntry(conversationId, piEntryId);
  }

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
    const sessionManager = SessionManager.create(this.paths.workspaceDir, this.paths.piSessionsDir);
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
    const sessionManager = SessionManager.create(this.paths.workspaceDir, this.paths.piSessionsDir);
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
        this.paths.workspaceDir,
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
    const handleToolEvent = createToolEventSubscriber({
      hostTools: this.hostTools,
      conversationId,
      queue,
      toolCalls,
      abortRun: () => void session.abort?.(),
    });
    const unsubscribe = session.subscribe((event: any) => {
      // A tool event is the subscriber's -- including one that arrives with host tools
      // disabled, which it refuses and ends the run over. Nothing below may see one.
      if (handleToolEvent(event)) {
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

  private async ensureSession(conversationId: string, activeModel: ConfiguredModel): Promise<any> {
    const cached = this.#sessions.get(conversationId);
    // Not just the model: a session created before llama.cpp first reported this
    // model's window clamps against the old number for its whole life.
    const contextWindow = requireContextWindow(activeModel, this.modelCache);
    if (cached && cached.modelId === activeModel.id && cached.contextWindow === contextWindow) {
      return cached.session;
    }

    cached?.session.dispose?.();
    const session = await createPiSession({
      paths: this.paths,
      store: this.store,
      conversations: this.conversations,
      hostTools: this.hostTools,
      modelCache: this.modelCache,
      settings: this.settings,
      conversationId,
      activeModel,
      customInstructions: () => this.customInstructions(),
      assertSessionAvailable: () => this.assertConversationSessionAvailable(conversationId),
    });
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
      this.paths.workspaceDir,
    );
    // These three are the client asking for something impossible, not the server breaking, so
    // they carry a code and become a 4xx. They used to be bare `Error`s and therefore bare 500s
    // -- and a 500 with no code is a thing no second client can render. An empty conversation is
    // the common one: there is genuinely nothing to duplicate.
    const entryId = input.entryId ?? sourceManager.getLeafId();
    if (!entryId) {
      throw notBranchableError(
        'This conversation has no messages yet, so there is nothing to branch from.',
      );
    }
    const entry = sourceManager.getEntry(entryId);
    if (!entry) {
      throw notBranchableError(`Entry ${entryId} was not found in the Pi session.`);
    }
    if (input.kind === 'fork' && !isUserMessageEntry(entry)) {
      throw notBranchableError('A conversation can only be forked from one of your own messages.');
    }

    const branchedSessionPath = sourceManager.createBranchedSession(entryId);
    if (!branchedSessionPath) {
      throw new Error('Pi did not create a branched session file.');
    }
    await ensureSessionFile(branchedSessionPath, sourceManager);
    const branchedManager = SessionManager.open(
      branchedSessionPath,
      this.paths.piSessionsDir,
      this.paths.workspaceDir,
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

  /**
   * Rebuilding the projection is `projection.ts`'s; the repository it writes through is the
   * harness's. Four call sites reach for it -- a snapshot read, a compaction, a run, and a
   * branch -- and every one of them means the same conversation's rows.
   */
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
    return syncPiConversation(
      this.conversations,
      conversationId,
      session,
      activeModel,
      assistantMessage,
      status,
      metadata,
    );
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

function isUserMessageEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const data = entry as {type?: unknown; message?: {role?: unknown}};
  return data.type === 'message' && data.message?.role === 'user';
}
