import {type ChangeEvent, useEffect, useMemo, useRef, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {HStack, VStack, StackItem, Layout, LayoutContent} from '@astryxdesign/core/Layout';
import {Text} from '@astryxdesign/core/Text';
import {IconButton} from '@astryxdesign/core/IconButton';
import {
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
} from '@astryxdesign/core/Chat';
import {Markdown} from '@astryxdesign/core/Markdown';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Spinner} from '@astryxdesign/core/Spinner';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {type SelectorOptionData, type SelectorOptionType} from '@astryxdesign/core/Selector';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import {Token} from '@astryxdesign/core/Token';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {Button} from '@astryxdesign/core/Button';
import {useToast} from '@astryxdesign/core/Toast';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Icon} from '@astryxdesign/core/Icon';
import {
  ArrowPathIcon,
  ArrowTrendingUpIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ClipboardDocumentIcon,
  ClockIcon,
  DocumentTextIcon,
  PhotoIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';

import {
  abortConversationCompaction,
  abortConversation,
  abortConversationRun,
  activateModel,
  clearConversation,
  cloneConversation,
  createConversation,
  deleteConversation,
  deleteAllConversations,
  deleteConfiguredModel,
  duplicateConfiguredModel,
  exportConversationArchive,
  forkConversation,
  getConversation,
  getConversations,
  rebuildConversation,
  repairConversation,
  getHostToolSettings,
  getLlamaModelProps,
  getLlamaModels,
  getLlamaRouterProps,
  getRuntime,
  getRuntimeLogs,
  getState,
  importConversationArchive,
  installRuntime,
  loadLlamaModel,
  reloadLlamaModels,
  searchHuggingFace,
  DEFAULT_REASONING_BUDGETS,
  setConversationPinned,
  setConversationReasoningLevel,
  startRuntime,
  stopRuntime,
  subscribeLlamaModelEvents,
  streamCompactConversation,
  streamConversationChat,
  streamRegenerateMessage,
  unloadLlamaModel,
  updateConversation,
  updateConfiguredModel,
  updateGlobalModelParams,
  updateHostToolSettings,
  fetchReasoningBudgets,
  updateReasoningBudgets,
  updateRuntimeSettings,
  useHuggingFaceModel,
  type ChatMessage as ApiChatMessage,
  type AttachmentMetadata,
  type ChatPerformance,
  type ChatPerformanceMetric,
  type ChatStreamEvent,
  type ConfiguredModel,
  type ConversationContextUsage,
  type ConversationListItem,
  type ConversationSnapshot,
  type HostToolSettings,
  type LlamaModelProps,
  type LlamaRouterModel,
  type LlamaRouterModelUpdate,
  MAX_REASONING_BUDGET,
  ModelParamsError,
  type LlamaRouterProps,
  type ReasoningBudgets,
  type ReasoningLevel,
  type RuntimeStatus,
  fetchSlashCommands,
  fetchDisplayPreferences,
  fetchPreferences,
  fetchSettingsGroup,
  fetchSettingsSchema,
  updateSettingsGroup,
  updatePreferences,
} from './api';
import {ChatComposerPanel} from './components/chat/ChatComposerPanel';
import {ThinkingBlock} from './components/chat/ThinkingBlock';
import {UnavailableConversationPanel} from './components/chat/UnavailableConversationPanel';
import {NelleSideNav} from './components/sidebar/NelleSideNav';
import {SettingsDialog} from './components/settings/SettingsDialog';
import {restoreComposerDraft, useComposerStore} from './stores/composerStore';
import {useConversationsStore} from './stores/conversationsStore';
import {usePreferencesStore} from './stores/preferencesStore';
import {GLOBAL_PARAM_SCOPE, useSettingsStore} from './stores/settingsStore';
import {useUiStore} from './stores/uiStore';
import type {ActiveRunKind, AppNotice, CommandStatusRow, ComposerModelOptionDetail} from './types';
import {attachmentTooltip, getDraftAttachmentError} from './utils/attachments';
import {
  parseCompactCommand,
  SLASH_COMMAND_REGISTRY,
  unsupportedSlashCommandMessage,
  type SlashCommandRegistry,
} from '../../../packages/shared/src/commands.ts';
import {isRunnableRouterStatus} from '../../../packages/shared/src/router.ts';
import {useScrollChatToBottomOnOpen} from './utils/chatScroll';
import {
  DELETE_UNDO_WINDOW_MS,
  cancelPendingDelete,
  registerPendingDeleteFlush,
  schedulePendingDelete,
} from './utils/pendingDeletes';
import {formatInteger, getContextOverflowMessage} from './utils/context';
import {parseReasoningBudgets} from './utils/reasoning';
import {rowsToParams} from './utils/params';

const FAVORITE_MODEL_IDS_STORAGE_KEY = 'nelle.favoriteModelIds';

// Composer status lives in the composer store so run/stream updates do not
// re-render the transcript. These wrappers keep the orchestration code readable.
function setComposerError(message: string | null): void {
  useComposerStore.getState().setError(message);
}

function setComposerWarning(message: string | null): void {
  useComposerStore.getState().setWarning(message);
}

function setSlashCommandError(message: string | null): void {
  useComposerStore.getState().setSlashCommandError(message);
}

function clearDraftAttachments(): void {
  useComposerStore.getState().setAttachments([]);
}

/**
 * The server already did this join.
 *
 * `mergeRouterModels` seeds its map from the `models.ini` sections and keys every
 * row by section id, matching the router's runtime id, aliases and `hf-repo` on
 * the way. `ConfiguredModel.id` is that section id. So the four extra conditions
 * this function used to try were a reimplementation of work already done, and a
 * rule a second client would have had to copy.
 */
function findRouterModelForConfiguredModel(
  model: ConfiguredModel,
  routerModels: LlamaRouterModel[],
): LlamaRouterModel | undefined {
  return routerModels.find(routerModel => routerModel.sectionId === model.id);
}

function routerStatusForModel(
  model: ConfiguredModel | null,
  routerModelsByConfiguredId: Map<string, LlamaRouterModel>,
  runtime: RuntimeStatus | null,
): string | null {
  if (!model) {
    return null;
  }
  return (
    routerModelsByConfiguredId.get(model.id)?.status ?? (runtime?.running ? 'unlisted' : 'stopped')
  );
}

/**
 * Cached `/api/llama/models/:id/props` result for one router status. `props` is
 * null when llama.cpp could not answer for that status, which keeps a failing
 * model from being re-requested on every render. A status change (for example
 * `sleeping` to `loaded`) invalidates the entry so props are fetched again.
 */
type ModelPropsEntry = {
  status: string;
  props: LlamaModelProps | null;
};

function modelPropsRequestKey(modelId: string, status: string): string {
  return `${modelId}:${status}`;
}

function mergeRouterModelUpdate(
  routerModels: LlamaRouterModel[],
  update: LlamaRouterModelUpdate,
): LlamaRouterModel[] {
  const index = routerModels.findIndex(model => routerModelMatchesUpdate(model, update));
  if (index < 0) {
    if (!update.sectionId && !update.routerModelId) {
      return routerModels;
    }
    return [
      ...routerModels,
      {
        sectionId: update.sectionId ?? update.routerModelId ?? 'unknown',
        routerModelId: update.routerModelId ?? update.sectionId,
        alias: update.alias ?? update.sectionId ?? update.routerModelId ?? 'unknown',
        hfRepo: update.hfRepo,
        status: update.status ?? 'unknown',
        progress: update.progress,
        aliases: update.aliases ?? [],
        source: update.source,
        architecture: update.architecture,
        raw: update.raw,
      },
    ];
  }

  const existing = routerModels[index]!;
  const next: LlamaRouterModel = {
    ...existing,
    routerModelId: update.routerModelId ?? existing.routerModelId,
    alias: update.alias ?? existing.alias,
    hfRepo: update.hfRepo ?? existing.hfRepo,
    status: update.status ?? existing.status,
    progress: update.progress ?? existing.progress,
    aliases: update.aliases ?? existing.aliases,
    source: update.source ?? existing.source,
    architecture: update.architecture ?? existing.architecture,
    raw: update.raw ?? existing.raw,
  };
  if (routerModelRenderEquals(existing, next)) {
    return routerModels;
  }
  return routerModels.map((model, modelIndex) => (modelIndex === index ? next : model));
}

/**
 * Router SSE events repeat the same payload while a model idles, and every event
 * carries a fresh `raw` object. Compare only the fields the UI renders so that a
 * no-op event does not rebuild `routerModels` and re-render the whole workbench.
 */
function routerModelRenderEquals(left: LlamaRouterModel, right: LlamaRouterModel): boolean {
  return (
    left.sectionId === right.sectionId &&
    left.routerModelId === right.routerModelId &&
    left.alias === right.alias &&
    left.hfRepo === right.hfRepo &&
    left.status === right.status &&
    left.progress === right.progress &&
    left.source === right.source &&
    left.architecture === right.architecture &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((alias, index) => alias === right.aliases[index])
  );
}

function routerModelMatchesUpdate(
  model: LlamaRouterModel,
  update: LlamaRouterModelUpdate,
): boolean {
  const candidateIds = [
    update.sectionId,
    update.routerModelId,
    update.hfRepo,
    ...(update.aliases ?? []),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  return candidateIds.some(
    candidate =>
      candidate === model.sectionId ||
      candidate === model.routerModelId ||
      candidate === model.hfRepo ||
      model.aliases.includes(candidate),
  );
}

function removeRunModel(
  activeRunModelsById: Record<string, string>,
  runId: string,
): Record<string, string> {
  if (!(runId in activeRunModelsById)) {
    return activeRunModelsById;
  }
  const next = {...activeRunModelsById};
  delete next[runId];
  return next;
}

function removeActiveRunId(
  activeRunIds: Record<string, string>,
  conversationId: string,
  runId?: string,
): Record<string, string> {
  const currentRunId = activeRunIds[conversationId];
  if (!currentRunId || (runId && currentRunId !== runId)) {
    return activeRunIds;
  }
  const next = {...activeRunIds};
  delete next[conversationId];
  return next;
}

export function App() {
  const showToast = useToast();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [routerModels, setRouterModels] = useState<LlamaRouterModel[]>([]);
  const [routerProps, setRouterProps] = useState<LlamaRouterProps | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [modelPropsById, setModelPropsById] = useState<Record<string, ModelPropsEntry>>({});
  const [favoriteModelIds, setFavoriteModelIds] = useState<string[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [capabilities, setCapabilities] = useState<ConversationSnapshot['capabilities'] | null>(
    null,
  );
  // "Not fetched yet" is not the same as "there are none". Until the list
  // arrives, the composer must not claim there is nothing to send to.
  const [hasLoadedConversations, setHasLoadedConversations] = useState(false);
  const [messages, setMessages] = useState<ApiChatMessage[]>([]);
  const [commandRows, setCommandRows] = useState<CommandStatusRow[]>([]);
  const [contextUsage, setContextUsage] = useState<ConversationContextUsage>({});
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningLevel>('off');
  const [reasoningBudgets, setReasoningBudgets] =
    useState<ReasoningBudgets>(DEFAULT_REASONING_BUDGETS);
  const [serverModelLoad, setServerModelLoad] = useState<{
    status: string;
    progress?: number;
  } | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<{
    conversationId: string;
    text: string;
  } | null>(null);
  const [hostTools, setHostTools] = useState<HostToolSettings | null>(null);
  const isSidebarCollapsed = useUiStore(state => state.isSidebarCollapsed);
  const setIsSidebarCollapsed = useUiStore(state => state.setSidebarCollapsed);
  const isSettingsOpen = useUiStore(state => state.isSettingsOpen);
  const setSettingsOpen = useUiStore(state => state.setSettingsOpen);
  const toggleSettings = useUiStore(state => state.toggleSettings);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeRunIds, setActiveRunIds] = useState<Record<string, string>>({});
  const [activeRunKindsByConversation, setActiveRunKindsByConversation] = useState<
    Record<string, ActiveRunKind>
  >({});
  const [activeRunModelsById, setActiveRunModelsById] = useState<Record<string, string>>({});
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortControllers = useRef(new Map<string, AbortController>());
  const compactAbortControllers = useRef(new Map<string, AbortController>());
  const activeConversationIdRef = useRef(activeConversationId);
  const modelPropsRequestsRef = useRef(new Set<string>());
  const isMountedRef = useRef(true);
  // The snapshot decides whether recovery is offered. `canRepair` is durable --
  // it stays true until a repair or rebuild succeeds -- unlike `canAbort` and
  // `canCompact`, which describe a run that may have started since the snapshot
  // was taken, and for which the browser's own live state is fresher.
  const isActiveConversationUnavailable = capabilities?.canRepair === true;

  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const [notice, setNotice] = useState<AppNotice | null>(null);

  useScrollChatToBottomOnOpen(chatScrollRef, activeConversationId);

  // A reload inside the undo window must commit the delete, not cancel it.
  useEffect(registerPendingDeleteFlush, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // The allowlist and its guidance copy live on the server, so a newly
  // allowlisted command needs no client release. The bundled registry is only
  // the fallback for the moment before the fetch resolves.
  const [commandRegistry, setCommandRegistry] = useState<SlashCommandRegistry | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const registry = await fetchSlashCommands();
        if (isMountedRef.current) {
          setCommandRegistry(registry);
        }
      } catch {
        // The bundled registry stands in until the server can be reached.
      }
    })();
  }, []);

  // The field list and its values both come from the server, so a setting added
  // there appears here without a client release. Drafts are seeded once, and
  // only the save that makes one stale may overwrite it.
  useEffect(() => {
    void (async () => {
      try {
        const {sections} = await fetchSettingsSchema();
        const values = await Promise.all(sections.map(group => fetchSettingsGroup(group.slug)));
        if (isMountedRef.current) {
          useSettingsStore
            .getState()
            .seedSettings(
              sections,
              Object.fromEntries(sections.map((group, index) => [group.slug, values[index]!])),
            );
        }
      } catch {
        // The General section says it is loading. Nothing else depends on this.
      }
    })();
  }, []);

  // Favorites and the display toggles live on the server so they follow the user
  // to another client. A browser that starred models before this existed hands
  // them over once.
  useEffect(() => {
    void (async () => {
      try {
        const [stored, display] = await Promise.all([
          fetchPreferences(),
          // The toggles are their own settings group now; `preferences` is favourites.
          fetchDisplayPreferences(),
        ]);
        usePreferencesStore.getState().seed(display);
        const orphaned = readLegacyFavoriteModelIds();
        const merged =
          orphaned.length > 0
            ? (
                await updatePreferences({
                  favoriteModelIds: [...new Set([...stored.favoriteModelIds, ...orphaned])],
                })
              ).favoriteModelIds
            : stored.favoriteModelIds;
        if (orphaned.length > 0) {
          clearLegacyFavoriteModelIds();
        }
        if (isMountedRef.current) {
          setFavoriteModelIds(merged);
        }
      } catch {
        // Favorites only reorder the model selector; chat works without them.
      }
    })();
  }, []);

  const activeModel = useMemo(
    () => models.find(model => model.id === activeModelId) ?? null,
    [activeModelId, models],
  );
  const activeModelProps =
    activeModelId == null ? null : (modelPropsById[activeModelId]?.props ?? null);
  // The server decides this from the chat template and caches it, so no client
  // carries llama.cpp's thinking detector. `null` while llama.cpp has not
  // reported a template -- it only answers `/props` for a model it has loaded --
  // and an unknown model must not be presented as one that cannot think.
  const activeModelCanReason = activeModelProps?.canReason ?? capabilities?.canReason ?? null;
  const favoriteModelIdSet = useMemo(() => new Set(favoriteModelIds), [favoriteModelIds]);
  const activeCommandRows = useMemo(
    () => commandRows.filter(row => row.conversationId === activeConversationId),
    [activeConversationId, commandRows],
  );
  const activeRunKind = activeRunKindsByConversation[activeConversationId];
  const isStreaming = activeRunKind === 'chat' || activeRunKind === 'regenerate';
  const isCompacting = activeRunKind === 'compact';
  const isActiveConversationBusy = isStreaming || isCompacting;
  // The server resolves the effective window -- llama.cpp's `/props` answer, the
  // configured cap, or nothing -- and stamps it on every snapshot and
  // `context.updated`. The browser used to override that with its own guess,
  // which is how a client comes to disagree with the server about a number only
  // the server can know.
  const displayedContextUsage = contextUsage;

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  const routerModelsByConfiguredId = useMemo(() => {
    const entries = new Map<string, LlamaRouterModel>();
    for (const model of models) {
      const routerModel = findRouterModelForConfiguredModel(model, routerModels);
      if (routerModel) {
        entries.set(model.id, routerModel);
      }
    }
    return entries;
  }, [models, routerModels]);
  const activeComposerRouterStatus = useMemo(
    () => routerStatusForModel(activeModel, routerModelsByConfiguredId, runtime),
    [activeModel, routerModelsByConfiguredId, runtime],
  );
  const activeModelIsFavorite = activeModelId != null && favoriteModelIdSet.has(activeModelId);
  const activePendingPrompt =
    pendingPrompt?.conversationId === activeConversationId ? pendingPrompt.text : null;
  // The run stream reports what the server is waiting for; the router SSE store
  // is the fallback for a load nobody is waiting on.
  const activeModelLoadPercent = normalizeRouterProgressPercent(
    serverModelLoad?.progress ??
      (activeModelId == null ? undefined : routerModelsByConfiguredId.get(activeModelId)?.progress),
  );
  const activeRunModelIdSet = useMemo(
    () => new Set(Object.values(activeRunModelsById)),
    [activeRunModelsById],
  );
  const composerModelDetailsById = useMemo(() => {
    const details = new Map<string, ComposerModelOptionDetail>();
    for (const model of models) {
      const routerModel = routerModelsByConfiguredId.get(model.id);
      const routerStatus = routerStatusForModel(model, routerModelsByConfiguredId, runtime);
      details.set(model.id, {
        model,
        routerModel,
        routerStatus: routerStatus ?? 'stopped',
        props: modelPropsById[model.id]?.props ?? null,
        isFavorite: favoriteModelIdSet.has(model.id),
        progressPercent: normalizeRouterProgressPercent(routerModel?.progress),
      });
    }
    return details;
  }, [favoriteModelIdSet, modelPropsById, models, routerModelsByConfiguredId, runtime]);
  const composerModelSelectorOptions = useMemo<SelectorOptionType[]>(() => {
    const favoriteOptions: SelectorOptionData[] = [];
    const otherOptions: SelectorOptionData[] = [];
    for (const model of models) {
      const option = {value: model.id, label: model.name};
      if (favoriteModelIdSet.has(model.id)) {
        favoriteOptions.push(option);
      } else {
        otherOptions.push(option);
      }
    }
    if (favoriteOptions.length === 0) {
      return otherOptions;
    }
    const sections: SelectorOptionType[] = [
      {type: 'section', title: 'Favorites', options: favoriteOptions},
    ];
    if (otherOptions.length > 0) {
      sections.push({type: 'section', title: 'All models', options: otherOptions});
    }
    return sections;
  }, [favoriteModelIdSet, models]);
  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      const response = await getState();
      if (isCancelled) {
        return;
      }
      setRuntime(response.runtime);
      const budgets = await fetchReasoningBudgets().catch(() => DEFAULT_REASONING_BUDGETS);
      setReasoningBudgets(budgets);
      const settings = useSettingsStore.getState();
      settings.resetReasoningDrafts(budgets);
      settings.resetRuntimeDrafts(
        response.runtime.modelsMax ?? response.state.runtime?.modelsMax,
        response.runtime.sleepIdleSeconds ?? response.state.runtime?.sleepIdleSeconds,
      );
      settings.seedModelDrafts(response.state.globalModelParams, response.state.models);
      setModels(response.state.models);
      setActiveModelId(response.state.activeModelId);
      setHostTools(response.hostTools ?? (await getHostToolSettings()));
      try {
        const list = await useConversationsStore.getState().loadFirstPage('');
        if (isCancelled) {
          return;
        }
        setHasLoadedConversations(true);
        // The server orders pinned first, then most recently updated.
        const nextConversationId = list[0]?.id ?? '';
        setActiveConversationId(nextConversationId);
        if (!nextConversationId) {
          setMessages([]);
          setContextUsage({});
          setReasoningLevel('off');
          setCapabilities(null);
          return;
        }
        const snapshot = await getConversation(nextConversationId);
        if (!isCancelled) {
          applyConversationSnapshot(
            snapshot,
            setMessages,
            setContextUsage,
            setReasoningLevel,
            setCapabilities,
          );
        }
      } catch {
        if (!isCancelled) {
          setMessages(response.state.chat);
          setContextUsage({});
        }
      }
      if (response.runtime.running) {
        try {
          const nextRouterModels = await getLlamaModels();
          if (!isCancelled) {
            setRouterModels(nextRouterModels);
          }
          try {
            const nextRouterProps = await getLlamaRouterProps();
            if (!isCancelled) {
              setRouterProps(nextRouterProps);
            }
          } catch {
            if (!isCancelled) {
              setRouterProps(null);
            }
          }
        } catch {
          if (!isCancelled) {
            setRouterModels([]);
            setRouterProps(null);
          }
        }
      } else {
        setRouterModels([]);
        setRouterProps(null);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runtime?.running) {
      return;
    }
    return subscribeLlamaModelEvents(event => {
      const modelUpdate = event.model;
      if (modelUpdate) {
        setRouterModels(prev => mergeRouterModelUpdate(prev, modelUpdate));
      }
    });
  }, [runtime?.running]);

  useEffect(() => {
    if (!runtime?.running) {
      modelPropsRequestsRef.current.clear();
      setModelPropsById(previous => (Object.keys(previous).length === 0 ? previous : {}));
      return;
    }
    const pending = models
      .map(model => ({model, status: routerModelsByConfiguredId.get(model.id)?.status}))
      .filter(
        (candidate): candidate is {model: ConfiguredModel; status: string} =>
          isRunnableRouterStatus(candidate.status) &&
          modelPropsById[candidate.model.id]?.status !== candidate.status &&
          !modelPropsRequestsRef.current.has(
            modelPropsRequestKey(candidate.model.id, candidate.status!),
          ),
      );
    if (pending.length === 0) {
      return;
    }
    for (const {model, status} of pending) {
      modelPropsRequestsRef.current.add(modelPropsRequestKey(model.id, status));
    }
    void (async () => {
      const entries = await Promise.all(
        pending.map(async ({model, status}) => {
          try {
            return [model.id, {status, props: await getLlamaModelProps(model.id)}] as const;
          } catch {
            return [model.id, {status, props: null}] as const;
          }
        }),
      );
      if (isMountedRef.current) {
        setModelPropsById(previous => {
          const next = {...previous};
          for (const [modelId, entry] of entries) {
            next[modelId] = entry;
          }
          return next;
        });
      }
      for (const {model, status} of pending) {
        modelPropsRequestsRef.current.delete(modelPropsRequestKey(model.id, status));
      }
    })();
  }, [modelPropsById, models, routerModelsByConfiguredId, runtime?.running]);

  /**
   * Refreshing must never overwrite a settings draft: a save triggers a refresh,
   * and the user may already be typing in another section by the time it lands.
   * Only whole models appearing or disappearing changes the draft set; each save
   * re-seeds its own fields from the values the server returned.
   */
  async function refreshState() {
    const response = await getState();
    setRuntime(response.runtime);
    setReasoningBudgets(await fetchReasoningBudgets().catch(() => DEFAULT_REASONING_BUDGETS));
    useSettingsStore.getState().reconcileModelDrafts(response.state.models);
    setModels(response.state.models);
    setActiveModelId(response.state.activeModelId);
    setHostTools(response.hostTools ?? (await getHostToolSettings()));
    // Model params may have changed on disk, so cached llama.cpp props are stale.
    setModelPropsById(previous => (Object.keys(previous).length === 0 ? previous : {}));
    await refreshConversations(activeConversationId, response.state.chat);
    if (response.runtime.running) {
      await refreshRouterModels({silent: true});
    } else {
      setRouterModels([]);
      setRouterProps(null);
    }
  }

  /**
   * Reloads the sidebar's first page and settles which conversation is active.
   *
   * `preferredConversationId` is authoritative when set. It must not be looked
   * up in the loaded page: the page is search-filtered, so a chat that simply
   * does not match the search box would otherwise be treated as deleted and the
   * user would be thrown into a different conversation as they typed. Callers
   * that know their conversation is gone pass `''` and get the newest one.
   */
  async function refreshConversations(
    preferredConversationId = activeConversationId,
    fallbackMessages: ApiChatMessage[] = [],
  ): Promise<void> {
    const conversationsStore = useConversationsStore.getState();
    const search = useUiStore.getState().conversationSearch.trim();
    try {
      const page = await conversationsStore.loadFirstPage(search);
      setHasLoadedConversations(true);
      // Falls back to '' when every conversation was deleted; nothing is bound
      // to a conversation id the server no longer knows about. Under an active
      // search the page cannot answer "what is the newest chat", so ask again
      // without the filter.
      const newest = search ? (await getConversations({limit: 1})).conversations : page;
      const nextConversationId = preferredConversationId || (newest[0]?.id ?? '');
      setActiveConversationId(nextConversationId);
      if (!nextConversationId) {
        setMessages([]);
        setContextUsage({});
        setReasoningLevel('off');
        setCapabilities(null);
        return;
      }
      const snapshot = await getConversation(nextConversationId);
      applyConversationSnapshot(
        snapshot,
        setMessages,
        setContextUsage,
        setReasoningLevel,
        setCapabilities,
      );
    } catch {
      setMessages(fallbackMessages);
      setContextUsage({});
    }
  }

  async function refreshRouterModels(
    input: {reload?: boolean; silent?: boolean} = {},
  ): Promise<void> {
    try {
      setRouterModels(input.reload ? await reloadLlamaModels() : await getLlamaModels());
      try {
        setRouterProps(await getLlamaRouterProps());
      } catch {
        setRouterProps(null);
      }
    } catch (error) {
      setRouterModels([]);
      setRouterProps(null);
      if (!input.silent) {
        throw error;
      }
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusyAction(label);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSearch() {
    const settingsStore = useSettingsStore.getState();
    settingsStore.setIsSearching(true);
    setNotice(null);
    try {
      settingsStore.setSearchResults(await searchHuggingFace(settingsStore.searchQuery));
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      useSettingsStore.getState().setIsSearching(false);
    }
  }

  async function handleSaveRuntimeSettings() {
    const {modelsMaxInput, sleepIdleInput} = useSettingsStore.getState();
    const modelsMax = Number.parseInt(modelsMaxInput, 10);
    const sleepIdleSeconds = Number.parseInt(sleepIdleInput, 10);
    if (!Number.isInteger(modelsMax) || modelsMax < 1) {
      setNotice({type: 'error', text: 'Max loaded models must be a positive integer.'});
      return;
    }
    if (!Number.isInteger(sleepIdleSeconds) || sleepIdleSeconds < 0) {
      setNotice({type: 'error', text: 'Sleep idle seconds must be zero or a positive integer.'});
      return;
    }

    await runAction('runtime-settings', async () => {
      const saved = await updateRuntimeSettings({modelsMax, sleepIdleSeconds});
      await refreshState();
      useSettingsStore
        .getState()
        .resetRuntimeDrafts(
          saved?.modelsMax ?? modelsMax,
          saved?.sleepIdleSeconds ?? sleepIdleSeconds,
        );
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Runtime settings saved. Restart llama.cpp to apply them.'
          : 'Runtime settings saved.',
      });
    });
  }

  /**
   * The server validates and returns the whole group, so the reset carries what
   * it stored rather than what the user typed. A field it refused names itself
   * in the error, which is the only thing the user needs.
   */
  async function handleSaveSettingsGroup(slug: string) {
    const settingsStore = useSettingsStore.getState();
    setBusyAction(`settings:${slug}`);
    settingsStore.setSettingsError(null);
    try {
      const draft = settingsStore.settingsDrafts[slug];
      if (draft) {
        settingsStore.resetSettingsDraft(slug, await updateSettingsGroup(slug, draft));
        setNotice({type: 'success', text: 'Settings saved.'});
      }
    } catch (error) {
      settingsStore.setSettingsError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(null);
    }
  }

  /**
   * A refused save marks the offending rows. `runAction` would show one line of
   * red text for a form with ten of them, which tells the user nothing they can
   * act on.
   */
  async function runParamsAction(
    label: string,
    scope: string,
    action: () => Promise<void>,
  ): Promise<void> {
    setBusyAction(label);
    setNotice(null);
    useSettingsStore.getState().setParamErrors(scope, []);
    try {
      await action();
    } catch (error) {
      if (error instanceof ModelParamsError) {
        useSettingsStore.getState().setParamErrors(scope, error.invalidParams);
      }
      setNotice({type: 'error', text: error instanceof Error ? error.message : String(error)});
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveGlobalParams() {
    await runParamsAction('global-params', GLOBAL_PARAM_SCOPE, async () => {
      const saved = await updateGlobalModelParams(
        rowsToParams(useSettingsStore.getState().globalParamRows),
      );
      await refreshState();
      useSettingsStore.getState().resetGlobalParamRows(saved);
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Global params saved and router models reloaded.'
          : 'Global params saved. Restart llama.cpp if it is already running elsewhere.',
      });
    });
  }

  async function handleSaveReasoningBudgets() {
    await runAction('reasoning-budgets', async () => {
      const inputs = useSettingsStore.getState().reasoningBudgetInputs;
      const budgets = parseReasoningBudgets(inputs);
      if (!budgets) {
        setNotice({
          type: 'error',
          text: `Reasoning budgets must be whole numbers between 0 and ${formatInteger(MAX_REASONING_BUDGET)}.`,
        });
        return;
      }
      const saved = await updateReasoningBudgets(budgets);
      setReasoningBudgets(saved);
      useSettingsStore.getState().resetReasoningDrafts(saved);
      setNotice({type: 'success', text: 'Reasoning budgets saved.'});
    });
  }

  async function handleSaveModelSettings(model: ConfiguredModel) {
    await runParamsAction(`model-save:${model.id}`, model.id, async () => {
      const {modelAliasDrafts, modelParamRows} = useSettingsStore.getState();
      const saved = await updateConfiguredModel(model.id, {
        name: modelAliasDrafts[model.id] ?? model.name,
        params: rowsToParams(modelParamRows[model.id] ?? []),
      });
      await refreshState();
      useSettingsStore.getState().resetModelDraft(saved);
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Model settings saved and router models reloaded.'
          : 'Model settings saved.',
      });
    });
  }

  async function handleHostToolsAcknowledgement() {
    await runAction('host-tools', async () => {
      const next = await updateHostToolSettings({enabled: true, acknowledged: true});
      setHostTools(next);
      setNotice({
        type: 'success',
        text: 'Host file and shell tools enabled for new agent runs.',
      });
    });
  }

  async function handleHostToolsToggle(enabled: boolean) {
    await runAction('host-tools', async () => {
      const next = await updateHostToolSettings({
        enabled,
        acknowledged: hostTools?.acknowledged ?? false,
      });
      setHostTools(next);
      setNotice({
        type: 'success',
        text: enabled
          ? 'Host file and shell tools enabled for new agent runs.'
          : 'Host file and shell tools disabled.',
      });
    });
  }

  async function handleDuplicateConfiguredModel(model: ConfiguredModel) {
    await runAction(`model-duplicate:${model.id}`, async () => {
      const copy = await duplicateConfiguredModel(model.id);
      setActiveModelId(copy.id);
      await refreshState();
      setNotice({type: 'success', text: 'Model duplicated.'});
    });
  }

  async function handleDeleteConfiguredModel(model: ConfiguredModel) {
    const confirmed = window.confirm(`Remove ${model.name} from models.ini?`);
    if (!confirmed) {
      return;
    }
    await runAction(`model-delete:${model.id}`, async () => {
      await deleteConfiguredModel(model.id);
      await refreshState();
      setNotice({type: 'success', text: 'Model removed.'});
    });
  }

  function updateCommandRow(id: string, patch: Partial<CommandStatusRow>) {
    setCommandRows(prev => prev.map(row => (row.id === id ? {...row, ...patch} : row)));
  }

  function updateActiveCompactionRows(patch: Partial<CommandStatusRow>) {
    setCommandRows(prev =>
      prev.map(row =>
        row.conversationId === activeConversationId &&
        row.kind === 'compact' &&
        (row.status === 'pending' || row.status === 'compacting')
          ? {...row, ...patch}
          : row,
      ),
    );
  }

  function setConversationRunKind(conversationId: string, kind: ActiveRunKind) {
    setActiveRunKindsByConversation(previous => ({...previous, [conversationId]: kind}));
  }

  function clearConversationRunKind(conversationId: string, expectedKind?: ActiveRunKind) {
    setActiveRunKindsByConversation(previous => {
      if (expectedKind && previous[conversationId] !== expectedKind) {
        return previous;
      }
      if (!previous[conversationId]) {
        return previous;
      }
      const next = {...previous};
      delete next[conversationId];
      return next;
    });
  }

  function setConversationListStatus(
    conversationId: string,
    status: ConversationListItem['status'],
  ) {
    useConversationsStore.getState().setStatus(conversationId, status);
  }

  async function handleToggleLogs() {
    await runAction('runtime-logs', async () => {
      const {isLogVisible, setIsLogVisible, setRuntimeLogs} = useSettingsStore.getState();
      if (!isLogVisible) {
        const logs = await getRuntimeLogs();
        setRuntimeLogs(logs.text);
      }
      setIsLogVisible(!isLogVisible);
    });
  }

  async function handleRefreshLogs() {
    await runAction('runtime-logs', async () => {
      const logs = await getRuntimeLogs();
      const {setIsLogVisible, setRuntimeLogs} = useSettingsStore.getState();
      setRuntimeLogs(logs.text);
      setIsLogVisible(true);
    });
  }

  async function handleReloadRouterModels() {
    await runAction('router-reload', async () => {
      await refreshRouterModels({reload: true});
      setNotice({type: 'success', text: 'Router model list reloaded.'});
    });
  }

  async function handleLoadRouterModel(model: ConfiguredModel) {
    await runAction(`load:${model.id}`, async () => {
      await loadLlamaModel(model.id);
      await refreshRouterModels();
      setNotice({type: 'success', text: `${model.name} load requested.`});
    });
  }

  async function handleUnloadRouterModel(model: ConfiguredModel) {
    await runAction(`unload:${model.id}`, async () => {
      await unloadLlamaModel(model.id);
      await refreshRouterModels();
      setNotice({type: 'success', text: `${model.name} unload requested.`});
    });
  }

  async function handleSelectComposerModel(model: ConfiguredModel) {
    // No early return on `model.id === activeModelId`: a run now uses the
    // *conversation's* model, so a chat pinned to B while A is globally active must
    // still be able to pin A. Re-picking the same model is idempotent anyway.
    await runAction(`composer-model:${model.id}`, async () => {
      // Kick the load off so the weights are warming while the user types; do not
      // wait for it. The chat route waits, and router SSE reports the progress.
      const routerModel = findRouterModelForConfiguredModel(model, routerModels);
      if (runtime?.running && routerModel && !isRunnableRouterStatus(routerModel.status)) {
        await loadLlamaModel(model.id).catch(() => {
          // The send will surface a real failure with model_load_failed.
        });
      }
      // Pin the open conversation: the run reads the conversation's model, so
      // activating alone would leave this selector looking inert.
      if (activeConversationId) {
        await updateConversation(activeConversationId, {defaultModelId: model.id});
      }
      // Still activate, so the choice also becomes the default new chats inherit.
      const activatedModel = await activateModel(model.id);
      setActiveModelId(activatedModel.id);
      await refreshConversations(activeConversationId);
      await refreshState();
    });
  }

  async function handleComposerModelSelectorChange(modelId: string) {
    const model = models.find(item => item.id === modelId);
    if (model) {
      await handleSelectComposerModel(model);
    }
  }

  async function handleSelectReasoningLevel(level: ReasoningLevel) {
    const conversationId = activeConversationIdRef.current;
    if (!conversationId) {
      return;
    }
    const previous = reasoningLevel;
    setReasoningLevel(level);
    try {
      const snapshot = await setConversationReasoningLevel(conversationId, level);
      if (conversationId === activeConversationIdRef.current) {
        setReasoningLevel(snapshot.conversation.reasoningLevel);
      }
    } catch (error) {
      setReasoningLevel(previous);
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleToggleActiveModelFavorite() {
    if (!activeModelId) {
      return;
    }
    const previous = favoriteModelIds;
    const next = previous.includes(activeModelId)
      ? previous.filter(modelId => modelId !== activeModelId)
      : [activeModelId, ...previous];
    setFavoriteModelIds(next);
    void (async () => {
      try {
        const saved = await updatePreferences({favoriteModelIds: next});
        if (isMountedRef.current) {
          setFavoriteModelIds(saved.favoriteModelIds);
        }
      } catch {
        // The star is a lie if the server never stored it.
        if (isMountedRef.current) {
          setFavoriteModelIds(previous);
        }
      }
    })();
  }

  function handleArchivePickerChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) {
      void handleImportConversationArchive(file);
    }
  }

  async function handleChatSubmit(value: string) {
    const prompt = normalizeComposerValue(value);
    const conversationId = activeConversationId;
    const composer = useComposerStore.getState();
    if (!prompt) {
      return;
    }
    if (!conversationId) {
      // The composer is disabled until a conversation is open, so this is a race
      // rather than a click. Hand the text back instead of swallowing it.
      restoreComposerDraft(prompt);
      return;
    }
    if (isActiveConversationBusy) {
      // The composer stays interactive during a run so stop remains clickable.
      // Put the draft back instead of silently swallowing it.
      restoreComposerDraft(prompt);
      composer.setWarning(
        isCompacting
          ? 'Wait for compaction to finish, or stop it before sending.'
          : 'Wait for the current response, or stop it before sending.',
      );
      return;
    }
    const compactInstructions = parseCompactCommand(prompt);
    if (compactInstructions != null) {
      await handleCompactConversation(compactInstructions);
      return;
    }
    const unsupportedSlashCommand = unsupportedSlashCommandMessage(
      prompt,
      commandRegistry ?? SLASH_COMMAND_REGISTRY,
    );
    if (unsupportedSlashCommand) {
      composer.setSlashCommandError(unsupportedSlashCommand);
      restoreComposerDraft(prompt);
      return;
    }
    const contextOverflow = getContextOverflowMessage(displayedContextUsage);
    if (contextOverflow) {
      composer.setError(`${contextOverflow} Run /compact to make room before sending.`);
      restoreComposerDraft(prompt);
      return;
    }
    const draftAttachments = composer.attachments;
    const attachmentError = getDraftAttachmentError(
      draftAttachments,
      activeModelProps?.modalities.vision === true,
    );
    if (attachmentError) {
      composer.setError(attachmentError);
      restoreComposerDraft(prompt);
      return;
    }
    if (!activeModel) {
      composer.setError('Select a GGUF model before chatting.');
      restoreComposerDraft(prompt);
      return;
    }
    // Loading a model can take tens of seconds. Show the prompt (and the load
    // progress) straight away instead of an empty transcript.
    setPendingPrompt({conversationId, text: prompt});
    // The server loads the model if it must, and streams `model.loading` while it
    // does. The prompt and its progress placeholder are already on screen.
    setConversationRunKind(conversationId, 'chat');
    setConversationListStatus(conversationId, 'running');
    setNotice(null);
    composer.setError(null);
    composer.setWarning(null);
    const abortController = new AbortController();
    streamAbortControllers.current.set(conversationId, abortController);
    let receivedRunStarted = false;
    // Whether the prompt became a turn. The server persists the user entry and
    // announces it; before that, nothing of the message exists anywhere.
    let messageBecameTurn = false;
    try {
      await streamConversationChat(
        conversationId,
        prompt,
        event => {
          if (event.type === 'run.started') {
            receivedRunStarted = true;
          }
          if (event.type === 'message.user.created') {
            messageBecameTurn = true;
          }
          applyChatEvent(event, conversationId);
        },
        abortController.signal,
        // References only. The bytes went to `POST /api/uploads`, and the server
        // decides whether each PDF reaches the model as text or as page images.
        draftAttachments.map(attachment => ({uploadId: attachment.uploadId})),
      );
      if (conversationId === activeConversationIdRef.current) {
        if (messageBecameTurn) {
          useComposerStore.getState().setAttachments([]);
        } else {
          // The server refused the message before it became a turn -- an
          // unaffordable scan, a model that would not load. The uploads are still
          // there, unbound, so hand the whole draft back rather than making the
          // user retype it and pick the files again.
          restoreComposerDraft(prompt);
        }
      }
      setRuntime(await getRuntime());
      await refreshConversations(activeConversationIdRef.current);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (conversationId === activeConversationIdRef.current) {
        useComposerStore
          .getState()
          .setError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setPendingPrompt(null);
      if (streamAbortControllers.current.get(conversationId) === abortController) {
        streamAbortControllers.current.delete(conversationId);
      }
      if (!receivedRunStarted) {
        clearConversationRunKind(conversationId, 'chat');
        setConversationListStatus(conversationId, 'ready');
      }
    }
  }

  async function handleCompactConversation(instructions: string) {
    const conversationId = activeConversationId;
    if (isActiveConversationBusy) {
      return;
    }
    const commandRow = createCompactCommandRow(conversationId, instructions);
    setCommandRows(prev => [...prev, commandRow]);
    setConversationRunKind(conversationId, 'compact');
    setConversationListStatus(conversationId, 'compacting');
    setSlashCommandError(null);
    setComposerError(null);
    setComposerWarning(null);
    updateCommandRow(commandRow.id, {
      status: 'compacting',
      message: 'Compacting conversation context...',
    });
    const abortController = new AbortController();
    compactAbortControllers.current.set(conversationId, abortController);
    let completed = false;
    let receivedRunStarted = false;
    try {
      await streamCompactConversation(
        conversationId,
        instructions || undefined,
        event => {
          if (event.type === 'run.started') {
            receivedRunStarted = true;
          }
          applyChatEvent(event, conversationId);
          if (event.type === 'run.started' && event.kind === 'compact') {
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'compacting',
              message: 'Compacting conversation context...',
            });
          }
          if (event.type === 'compact.started') {
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'compacting',
              instructions: event.instructions ?? instructions,
              message: 'Compacting conversation context...',
            });
          }
          if (event.type === 'compact.completed') {
            completed = true;
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'completed',
              message: 'Conversation compacted.',
              completedAt: event.createdAt,
            });
          }
          if (event.type === 'compact.failed') {
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'failed',
              message: event.error.message,
              completedAt: event.createdAt,
            });
            if (conversationId === activeConversationIdRef.current) {
              setComposerError(event.error.message);
            }
          }
          if (event.type === 'run.aborted') {
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'aborted',
              message: 'Compaction stopped.',
              completedAt: event.createdAt,
            });
            if (conversationId === activeConversationIdRef.current) {
              setComposerWarning('Compaction stopped.');
            }
          }
          if (event.type === 'run.completed' && event.status === 'aborted') {
            updateCommandRow(commandRow.id, {
              runId: event.runId,
              status: 'aborted',
              message: 'Compaction stopped.',
              completedAt: event.createdAt,
            });
          }
          if (event.type === 'error') {
            updateCommandRow(commandRow.id, {
              status: 'failed',
              message: event.message,
              completedAt: new Date().toISOString(),
            });
          }
        },
        abortController.signal,
      );
      if (completed) {
        if (conversationId === activeConversationIdRef.current) {
          const snapshot = await getConversation(conversationId);
          applyConversationSnapshot(
            snapshot,
            setMessages,
            setContextUsage,
            setReasoningLevel,
            setCapabilities,
          );
        }
        await refreshConversations(activeConversationIdRef.current);
      }
    } catch (error) {
      if (isAbortError(error)) {
        updateCommandRow(commandRow.id, {
          status: 'aborted',
          message: 'Compaction stopped.',
          completedAt: new Date().toISOString(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      updateCommandRow(commandRow.id, {
        status: 'failed',
        message,
        completedAt: new Date().toISOString(),
      });
      if (conversationId === activeConversationIdRef.current) {
        setComposerError(message);
      }
    } finally {
      if (compactAbortControllers.current.get(conversationId) === abortController) {
        compactAbortControllers.current.delete(conversationId);
      }
      if (!receivedRunStarted) {
        clearConversationRunKind(conversationId, 'compact');
        setConversationListStatus(conversationId, 'ready');
      }
    }
  }

  async function handleResetConversation(conversationId = activeConversationId) {
    await runAction('reset-chat', async () => {
      await clearConversation(conversationId);
      if (conversationId === activeConversationId) {
        setMessages([]);
        setContextUsage({});
      }
      await refreshConversations(activeConversationId);
      setNotice({type: 'success', text: 'Conversation reset.'});
    });
  }

  async function handleNewConversation() {
    await runAction('new-chat', async () => {
      const created = await createConversation({defaultModelId: activeModelId});
      setActiveConversationId(created.id);
      setMessages([]);
      setContextUsage({});
      clearDraftAttachments();
      await refreshConversations(created.id);
    });
  }

  async function handleRepairConversation(conversation: ConversationListItem) {
    await runAction(`repair:${conversation.id}`, async () => {
      const snapshot = await repairConversation(conversation.id);
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation repaired.'});
    });
  }

  async function handleRebuildConversation(conversation: ConversationListItem) {
    const confirmed = window.confirm(
      `Rebuild "${conversation.title}" from the messages Nelle saved?\n\n` +
        'This writes a new Pi session from Nelle’s own copy of the conversation. ' +
        'The messages, their order, and their reasoning are restored. Tool results, ' +
        'attached image content, compaction summaries, and alternative regenerated ' +
        'answers are not.\n\n' +
        'Repair the original session file instead if you can still find it.',
    );
    if (!confirmed) {
      return;
    }
    await runAction(`rebuild:${conversation.id}`, async () => {
      const snapshot = await rebuildConversation(conversation.id);
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation rebuilt from saved messages.'});
    });
  }

  /** The chat pane's recovery buttons act on whatever conversation is open. */
  function activeConversationItem(): ConversationListItem | undefined {
    return useConversationsStore
      .getState()
      .conversations.find(conversation => conversation.id === activeConversationId);
  }

  async function handleRepairActiveConversation() {
    const conversation = activeConversationItem();
    if (conversation) {
      await handleRepairConversation(conversation);
    }
  }

  async function handleRebuildActiveConversation() {
    const conversation = activeConversationItem();
    if (conversation) {
      await handleRebuildConversation(conversation);
    }
  }

  async function handleDeleteActiveConversation() {
    const conversation = activeConversationItem();
    if (conversation) {
      await handleDeleteConversation(conversation);
    }
  }

  async function handleSelectConversation(conversationId: string) {
    setSlashCommandError(null);
    setComposerError(null);
    setComposerWarning(null);
    clearDraftAttachments();
    setActiveConversationId(conversationId);
    await refreshConversations(conversationId);
  }

  async function handleRenameConversation(conversation: ConversationListItem) {
    const title = window.prompt('Rename conversation', conversation.title)?.trim();
    if (!title || title === conversation.title) {
      return;
    }
    await runAction(`rename:${conversation.id}`, async () => {
      await updateConversation(conversation.id, {title});
      await refreshConversations(activeConversationId);
    });
  }

  async function handleToggleConversationPin(conversation: ConversationListItem) {
    await runAction(`pin:${conversation.id}`, async () => {
      await setConversationPinned(conversation.id, !conversation.pinned);
      await refreshConversations(activeConversationId);
    });
  }

  /**
   * Removes the conversation from the sidebar at once and holds the request for
   * the undo window.
   *
   * There is no confirmation dialog: the toast is the confirmation, and it is
   * reversible, which a dialog is not. Once the request lands, the Pi session
   * file and any unreferenced attachments are gone, so the toast copy says so.
   */
  async function handleDeleteConversation(conversation: ConversationListItem) {
    const store = useConversationsStore.getState();
    const wasActive = conversation.id === activeConversationId;
    store.hideConversation(conversation.id);
    if (wasActive) {
      setMessages([]);
      setContextUsage({});
      setCapabilities(null);
      setActiveConversationId('');
    }

    const nextVisible = useConversationsStore.getState().conversations[0]?.id ?? '';
    if (wasActive && nextVisible) {
      await handleSelectConversation(nextVisible);
    }

    schedulePendingDelete(conversation.id, () => {
      void (async () => {
        try {
          await deleteConversation(conversation.id);
        } catch (error) {
          setNotice({
            type: 'error',
            text: error instanceof Error ? error.message : String(error),
          });
        } finally {
          useConversationsStore.getState().unhideConversation(conversation.id);
        }
      })();
    });

    showToast({
      body: `Deleted "${conversation.title}". Its session file and attachments go with it.`,
      uniqueID: `delete:${conversation.id}`,
      collisionBehavior: 'overwrite',
      isAutoHide: true,
      autoHideDuration: DELETE_UNDO_WINDOW_MS,
      endContent: (
        <Button
          label="Undo"
          size="sm"
          variant="ghost"
          onClick={() => void handleUndoDeleteConversation(conversation)}
        />
      ),
    });
  }

  async function handleUndoDeleteConversation(conversation: ConversationListItem) {
    if (!cancelPendingDelete(conversation.id)) {
      // The window already closed and the request went out.
      return;
    }
    useConversationsStore.getState().unhideConversation(conversation.id);
    await refreshConversations(conversation.id);
  }

  async function handleClearAllConversations() {
    if (!window.confirm('Delete all conversations and their local session files?')) {
      return;
    }
    await runAction('clear-all-chats', async () => {
      await deleteAllConversations();
      setMessages([]);
      setContextUsage({});
      await refreshConversations('');
      setNotice({type: 'success', text: 'All conversations cleared.'});
    });
  }

  async function handleExportConversation(conversation: ConversationListItem) {
    await runAction(`export:${conversation.id}`, async () => {
      const blob = await exportConversationArchive(conversation.id);
      downloadBlob(blob, archiveFilename(conversation.title));
      setNotice({type: 'success', text: 'Conversation exported.'});
    });
  }

  async function handleImportConversationArchive(file: File) {
    await runAction('import-chat', async () => {
      const snapshot = await importConversationArchive(file);
      setActiveConversationId(snapshot.conversation.id);
      applyConversationSnapshot(
        snapshot,
        setMessages,
        setContextUsage,
        setReasoningLevel,
        setCapabilities,
      );
      clearDraftAttachments();
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation imported.'});
    });
  }

  async function handleCloneConversation(conversation: ConversationListItem) {
    await runAction(`clone:${conversation.id}`, async () => {
      const snapshot = await cloneConversation(conversation.id);
      setActiveConversationId(snapshot.conversation.id);
      applyConversationSnapshot(
        snapshot,
        setMessages,
        setContextUsage,
        setReasoningLevel,
        setCapabilities,
      );
      clearDraftAttachments();
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation duplicated.'});
    });
  }

  async function handleForkMessage(message: ApiChatMessage) {
    if (message.role !== 'user' || isActiveConversationBusy) {
      return;
    }
    await runAction(`fork:${message.id}`, async () => {
      const snapshot = await forkConversation(activeConversationId, message.id);
      setActiveConversationId(snapshot.conversation.id);
      applyConversationSnapshot(
        snapshot,
        setMessages,
        setContextUsage,
        setReasoningLevel,
        setCapabilities,
      );
      clearDraftAttachments();
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation forked.'});
    });
  }

  async function handleStopGeneration() {
    await runAction('abort-chat', async () => {
      const conversationId = activeConversationId;
      const runId = activeRunIds[conversationId];
      const abortRequest = runId
        ? abortConversationRun(conversationId, runId)
        : abortConversation(conversationId);
      streamAbortControllers.current.get(conversationId)?.abort();
      setActiveRunIds(previous => removeActiveRunId(previous, conversationId, runId));
      clearConversationRunKind(conversationId);
      setConversationListStatus(conversationId, 'ready');
      if (runId) {
        setActiveRunModelsById(previous => removeRunModel(previous, runId));
      }
      const abortResult = await abortRequest;
      await refreshConversations(activeConversationIdRef.current);
      const warning = getAbortWarningMessage(abortResult);
      if (warning) {
        setComposerWarning(warning);
        setNotice({type: 'warning', text: warning});
      } else {
        setNotice({type: 'info', text: 'Generation stopped.'});
      }
    });
  }

  async function handleStopCompaction() {
    await runAction('abort-compaction', async () => {
      const conversationId = activeConversationId;
      const runId = activeRunIds[conversationId];
      const abortRequest = runId
        ? abortConversationRun(conversationId, runId)
        : abortConversationCompaction(conversationId);
      compactAbortControllers.current.get(conversationId)?.abort();
      setActiveRunIds(previous => removeActiveRunId(previous, conversationId, runId));
      clearConversationRunKind(conversationId);
      setConversationListStatus(conversationId, 'ready');
      if (runId) {
        setActiveRunModelsById(previous => removeRunModel(previous, runId));
      }
      const abortResult = await abortRequest;
      updateActiveCompactionRows({
        status: 'aborted',
        message: 'Compaction stopped.',
        completedAt: new Date().toISOString(),
      });
      await refreshConversations(activeConversationIdRef.current);
      const warning = getAbortWarningMessage(abortResult);
      if (warning) {
        setComposerWarning(warning);
        setNotice({type: 'warning', text: warning});
      } else {
        setNotice({type: 'info', text: 'Compaction stopped.'});
      }
    });
  }

  async function handleRegenerateMessage(message: ApiChatMessage, modelId?: string) {
    const conversationId = activeConversationId;
    if (message.role !== 'assistant' || isActiveConversationBusy) {
      return;
    }
    const selectedModelId = modelId ?? message.modelId ?? activeModelId;
    if (!selectedModelId) {
      setNotice({type: 'error', text: 'Select a model before regenerating a response.'});
      return;
    }

    setConversationRunKind(conversationId, 'regenerate');
    setConversationListStatus(conversationId, 'running');
    setNotice(null);
    setComposerError(null);
    setComposerWarning(null);
    const abortController = new AbortController();
    streamAbortControllers.current.set(conversationId, abortController);
    let receivedRunStarted = false;
    try {
      await streamRegenerateMessage(
        conversationId,
        message.id,
        selectedModelId,
        event => {
          if (event.type === 'run.started') {
            receivedRunStarted = true;
          }
          applyChatEvent(event, conversationId);
        },
        abortController.signal,
      );
      setRuntime(await getRuntime());
      await refreshConversations(activeConversationIdRef.current);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      if (conversationId === activeConversationIdRef.current) {
        setComposerError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (streamAbortControllers.current.get(conversationId) === abortController) {
        streamAbortControllers.current.delete(conversationId);
      }
      if (!receivedRunStarted) {
        clearConversationRunKind(conversationId, 'regenerate');
        setConversationListStatus(conversationId, 'ready');
      }
    }
  }

  async function handleCopyMessage(message: ApiChatMessage) {
    try {
      await copyMessageText(message.content);
      showToast({
        body: 'Response copied.',
        uniqueID: 'copy-response',
        collisionBehavior: 'overwrite',
        isAutoHide: true,
        autoHideDuration: 3000,
      });
    } catch (error) {
      showToast({
        body: error instanceof Error ? error.message : 'Could not copy response.',
        type: 'error',
        uniqueID: 'copy-response',
        collisionBehavior: 'overwrite',
      });
    }
  }

  function applyChatEvent(event: ChatStreamEvent, sourceConversationId?: string) {
    const conversationId = getChatEventConversationId(event, sourceConversationId);
    const isVisibleConversation = conversationId === activeConversationIdRef.current;
    if (event.type === 'run.started') {
      setActiveRunIds(previous => ({...previous, [event.conversationId]: event.runId}));
      setConversationRunKind(event.conversationId, event.kind);
      const status = conversationStatusForRunKind(event.kind);
      if (status) {
        setConversationListStatus(event.conversationId, status);
      }
      const modelId = event.modelId;
      if (modelId) {
        setActiveRunModelsById(previous => ({...previous, [event.runId]: modelId}));
      }
    }
    if (event.type === 'run.aborted') {
      setActiveRunIds(previous => removeActiveRunId(previous, event.conversationId, event.runId));
      clearConversationRunKind(event.conversationId);
      setConversationListStatus(event.conversationId, 'ready');
      setActiveRunModelsById(previous => removeRunModel(previous, event.runId));
      if (isVisibleConversation) {
        setComposerWarning('Generation stopped.');
      }
    }
    if (event.type === 'run.completed') {
      setServerModelLoad(null);
      setActiveRunModelsById(previous => removeRunModel(previous, event.runId));
      clearConversationRunKind(event.conversationId);
      setConversationListStatus(event.conversationId, 'ready');
      setActiveRunIds(previous => {
        if (previous[event.conversationId] !== event.runId) {
          return previous;
        }
        const next = {...previous};
        delete next[event.conversationId];
        return next;
      });
      if (isVisibleConversation && event.status === 'failed' && event.error?.message) {
        setComposerError(event.error.message);
      }
    }
    if (event.type === 'context.updated') {
      if (event.conversationId === activeConversationIdRef.current) {
        setContextUsage({
          usedTokens: event.usedTokens,
          totalTokens: event.totalTokens,
          source: event.source,
          status: event.status,
          updatedAt: event.updatedAt ?? event.createdAt,
        });
      }
    }
    if (event.type === 'model.loading') {
      if (isVisibleConversation) {
        // The server is waiting for weights. Show its progress rather than the
        // router SSE store's, which lags a poll behind.
        setServerModelLoad({status: event.status, progress: event.progress});
      }
      return;
    }
    if (event.type === 'message.user.created') {
      // The server has the prompt now; drop the optimistic copy.
      setPendingPrompt(previous => (previous?.conversationId === conversationId ? null : previous));
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev => [...prev, event.message]);
    }
    if (event.type === 'message.assistant.started') {
      setServerModelLoad(null);
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev => [...prev, event.message]);
    }
    if (event.type === 'message.assistant.reasoning_delta') {
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev =>
        prev.map(message =>
          message.id === event.id
            ? {
                ...message,
                reasoning: (message.reasoning ?? '') + event.delta,
                isReasoning: event.isReasoning,
              }
            : message,
        ),
      );
    }
    if (event.type === 'message.assistant.delta') {
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev =>
        prev.map(message =>
          message.id === event.id
            ? {...message, content: message.content + event.delta, isReasoning: event.isReasoning}
            : message,
        ),
      );
    }
    if (event.type === 'performance.updated') {
      if (!isVisibleConversation) {
        return;
      }
      // `performance.updated` already carries the merged reading: both harnesses
      // merge into the assistant message before emitting. Merging again here
      // used a second, subtly different rule.
      setMessages(prev =>
        prev.map(message =>
          message.id === event.id ? {...message, performance: event.performance} : message,
        ),
      );
    }
    if (event.type === 'tool_call.updated') {
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev => {
        let assistantIndex = -1;
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          if (prev[index].role === 'assistant') {
            assistantIndex = index;
            break;
          }
        }
        if (assistantIndex < 0) {
          return prev;
        }
        const copy = [...prev];
        const assistant = copy[assistantIndex];
        const toolCalls = [...(assistant.toolCalls ?? [])];
        const toolIndex = toolCalls.findIndex(call => call.id === event.call.id);
        if (toolIndex >= 0) {
          toolCalls[toolIndex] = {...toolCalls[toolIndex], ...event.call};
        } else {
          toolCalls.push(event.call);
        }
        copy[assistantIndex] = {...assistant, toolCalls};
        return copy;
      });
    }
    if (event.type === 'run.warning') {
      if (isVisibleConversation) {
        setComposerWarning(event.message);
      }
    }
    if (event.type === 'conversation.updated' && event.title) {
      useConversationsStore
        .getState()
        .setConversationTitle(event.conversationId, event.title, event.titleSource ?? 'generated');
    }
    if (event.type === 'message.assistant.completed') {
      if (!isVisibleConversation) {
        return;
      }
      setMessages(prev =>
        prev.map(message => (message.id === event.message.id ? event.message : message)),
      );
    }
    if (event.type === 'error') {
      if (isVisibleConversation) {
        setComposerError(event.message);
      }
    }
  }

  const runtimeTone = runtime?.running ? 'green' : runtime?.installed ? 'yellow' : 'blue';

  return (
    <AppShell
      contentPadding={0}
      height="fill"
      variant="surface"
      sideNav={
        <NelleSideNav
          isCollapsed={isSidebarCollapsed}
          onCollapsedChange={setIsSidebarCollapsed}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          isSettingsOpen={isSettingsOpen}
          onToggleSettings={toggleSettings}
          onNewConversation={handleNewConversation}
          isNewConversationBusy={busyAction === 'new-chat'}
          onImportConversation={() => archiveInputRef.current?.click()}
          isImportBusy={busyAction === 'import-chat'}
          archiveInputRef={archiveInputRef}
          onArchivePickerChange={handleArchivePickerChange}
          activeConversationId={activeConversationId}
          onSelect={handleSelectConversation}
          onTogglePin={handleToggleConversationPin}
          onRename={handleRenameConversation}
          onReset={handleResetConversation}
          onExport={handleExportConversation}
          onRepair={handleRepairConversation}
          onRebuild={handleRebuildConversation}
          onClone={handleCloneConversation}
          onDelete={handleDeleteConversation}
        />
      }
    >
      <Layout
        height="fill"
        content={
          <LayoutContent padding={0}>
            <HStack height="100%" className="nelle-workbench">
              <StackItem size="fill" className="nelle-chat-column">
                <ChatLayout
                  ref={chatScrollRef}
                  data-testid="chat-layout"
                  className="nelle-chat-layout"
                  density="spacious"
                  composer={
                    <ChatComposerPanel
                      activeModel={activeModel}
                      activeModelProps={activeModelProps}
                      conversationId={activeConversationId}
                      activeModelId={activeModelId}
                      activeModelIsFavorite={activeModelIsFavorite}
                      activeComposerRouterStatus={activeComposerRouterStatus}
                      isRuntimeRunning={runtime?.running === true}
                      hasActiveConversation={!hasLoadedConversations || activeConversationId !== ''}
                      isConversationUnavailable={isActiveConversationUnavailable}
                      contextUsage={displayedContextUsage}
                      isStreaming={isStreaming}
                      isCompacting={isCompacting}
                      composerModelSelectorOptions={composerModelSelectorOptions}
                      composerModelDetailsById={composerModelDetailsById}
                      reasoningLevel={reasoningLevel}
                      reasoningBudgets={reasoningBudgets}
                      canReason={activeModelCanReason}
                      onSubmit={handleChatSubmit}
                      onStop={() =>
                        void (isCompacting ? handleStopCompaction() : handleStopGeneration())
                      }
                      onSelectModel={handleComposerModelSelectorChange}
                      onSelectReasoningLevel={handleSelectReasoningLevel}
                      onToggleFavorite={handleToggleActiveModelFavorite}
                    />
                  }
                >
                  <ChatMessageList>
                    {isActiveConversationUnavailable && (
                      <UnavailableConversationPanel
                        conversationId={activeConversationId}
                        isBusy={busyAction != null}
                        onRepair={() => void handleRepairActiveConversation()}
                        onRebuild={() => void handleRebuildActiveConversation()}
                        onDelete={() => void handleDeleteActiveConversation()}
                      />
                    )}
                    {!isActiveConversationUnavailable &&
                      messages.length === 0 &&
                      !activePendingPrompt && (
                        <ChatSystemMessage>
                          {emptyTranscriptMessage(runtime, activeModel)}
                        </ChatSystemMessage>
                      )}
                    {!isActiveConversationUnavailable &&
                      messages.map(message => (
                        <RenderedMessage
                          key={message.id}
                          message={message}
                          models={models}
                          isActionDisabled={isStreaming || isCompacting}
                          onRegenerate={handleRegenerateMessage}
                          onCopy={handleCopyMessage}
                          onFork={handleForkMessage}
                        />
                      ))}
                    {activePendingPrompt && (
                      <PendingPromptMessages
                        text={activePendingPrompt}
                        routerStatus={activeComposerRouterStatus}
                        progressPercent={activeModelLoadPercent}
                      />
                    )}
                    {activeCommandRows.map(row => (
                      <CommandStatusMessage key={row.id} row={row} />
                    ))}
                  </ChatMessageList>
                </ChatLayout>
              </StackItem>
            </HStack>
            {isSettingsOpen && (
              <SettingsDialog
                isOpen={isSettingsOpen}
                onOpenChange={setSettingsOpen}
                runtime={runtime}
                routerProps={routerProps}
                routerModels={routerModels}
                runtimeTone={runtimeTone}
                onInstall={() =>
                  runAction('install', async () => {
                    setRuntime(await installRuntime());
                  })
                }
                onStart={() =>
                  runAction('start', async () => {
                    setRuntime(await startRuntime());
                    await refreshState();
                  })
                }
                onStop={() =>
                  runAction('stop', async () => {
                    setRuntime(await stopRuntime());
                    setRouterModels([]);
                    setRouterProps(null);
                  })
                }
                onRefresh={() =>
                  runAction('refresh', async () => {
                    await refreshState();
                  })
                }
                onToggleLogs={handleToggleLogs}
                onRefreshLogs={handleRefreshLogs}
                onSaveRuntimeSettings={handleSaveRuntimeSettings}
                models={models}
                activeModelId={activeModelId}
                activeRunModelIds={activeRunModelIdSet}
                routerModelsByConfiguredId={routerModelsByConfiguredId}
                busyAction={busyAction}
                onActivateModel={model =>
                  runAction('activate', async () => {
                    const updated = await activateModel(model.id);
                    setActiveModelId(updated.id);
                    await refreshState();
                  })
                }
                onLoadModel={handleLoadRouterModel}
                onUnloadModel={handleUnloadRouterModel}
                onReloadRouterModels={handleReloadRouterModels}
                onSaveModel={handleSaveModelSettings}
                onDuplicateModel={handleDuplicateConfiguredModel}
                onDeleteModel={handleDeleteConfiguredModel}
                onSaveGlobalParams={handleSaveGlobalParams}
                onSaveSettingsGroup={handleSaveSettingsGroup}
                onSaveReasoningBudgets={handleSaveReasoningBudgets}
                hostTools={hostTools}
                onAcknowledgeHostTools={handleHostToolsAcknowledgement}
                onHostToolsToggle={handleHostToolsToggle}
                onSearch={handleSearch}
                onUseHuggingFaceModel={(repoId, quant) =>
                  runAction(`use:${repoId}:${quant}`, async () => {
                    await useHuggingFaceModel({repoId, quant});
                    await refreshState();
                  })
                }
                onImportConversation={() => archiveInputRef.current?.click()}
                isImporting={busyAction === 'import-chat'}
                onClearAllChats={() => void handleClearAllConversations()}
              />
            )}
          </LayoutContent>
        }
      />
    </AppShell>
  );
}

function applyConversationSnapshot(
  snapshot: ConversationSnapshot,
  setMessages: (messages: ApiChatMessage[]) => void,
  setContextUsage: (context: ConversationContextUsage) => void,
  setReasoningLevel: (level: ReasoningLevel) => void,
  setCapabilities: (capabilities: ConversationSnapshot['capabilities'] | null) => void,
) {
  setMessages(messagesFromSnapshot(snapshot));
  setContextUsage(snapshot.context ?? {});
  setReasoningLevel(snapshot.conversation.reasoningLevel ?? 'off');
  setCapabilities(snapshot.capabilities);
}

function getAbortWarningMessage(response: {warning?: {message?: string}}): string | null {
  const message = response.warning?.message?.trim();
  return message || null;
}

function getChatEventConversationId(
  event: ChatStreamEvent,
  fallbackConversationId?: string,
): string | undefined {
  return 'conversationId' in event ? event.conversationId : fallbackConversationId;
}

function conversationStatusForRunKind(kind: ActiveRunKind): ConversationListItem['status'] | null {
  if (kind === 'chat' || kind === 'regenerate') {
    return 'running';
  }
  if (kind === 'compact') {
    return 'compacting';
  }
  return null;
}

function normalizeRouterProgressPercent(progress: number | undefined): number | null {
  if (progress == null || !Number.isFinite(progress)) {
    return null;
  }
  const percent = progress <= 1 ? progress * 100 : progress;
  return Math.min(100, Math.max(0, percent));
}

/**
 * Shown between pressing send and the server accepting the prompt. Loading a
 * model can take tens of seconds, and llama.cpp's own UI surfaces the progress
 * in the transcript rather than only in a model picker.
 */
function PendingPromptMessages({
  text,
  routerStatus,
  progressPercent,
}: {
  text: string;
  routerStatus: string | null;
  progressPercent: number | null;
}) {
  const isLoading = routerStatus === 'loading' || routerStatus === 'unloaded';
  const label = isLoading ? 'Loading weights' : 'Preparing';
  return (
    <>
      <ChatMessage sender="user">
        <ChatMessageBubble>{text}</ChatMessageBubble>
      </ChatMessage>
      <ChatMessage sender="assistant" avatar={<Avatar name="Nelle" size="small" />}>
        <ChatMessageBubble variant="ghost">
          <VStack gap={2} className="nelle-model-loading">
            <HStack gap={2} vAlign="center">
              <Spinner size="sm" shade="subtle" aria-label={`${label} in progress`} />
              <Text type="supporting" color="secondary">
                {label}
                {isLoading && progressPercent != null ? ` ${Math.round(progressPercent)}%` : ''}
              </Text>
            </HStack>
            {isLoading && (
              <ProgressBar
                label="Model load progress"
                isLabelHidden
                value={progressPercent ?? 0}
                isIndeterminate={progressPercent == null}
                variant="accent"
              />
            )}
          </VStack>
        </ChatMessageBubble>
      </ChatMessage>
    </>
  );
}

/** The old copy told users to install llama.cpp even when it was already running. */
function emptyTranscriptMessage(
  runtime: RuntimeStatus | null,
  activeModel: ConfiguredModel | null,
): string {
  if (!runtime?.installed) {
    return 'Install llama.cpp from Settings > Runtime to get started.';
  }
  if (!runtime.running) {
    return 'Start llama.cpp from Settings > Runtime to get started.';
  }
  if (!activeModel) {
    return 'Add a GGUF model from Settings > Models, then select it in the composer.';
  }
  return 'Ask Nelle to inspect files, run shell commands, or reason about this project.';
}

function CommandStatusMessage({row}: {row: CommandStatusRow}) {
  const color =
    row.status === 'completed'
      ? 'green'
      : row.status === 'failed'
        ? 'red'
        : row.status === 'aborted'
          ? 'yellow'
          : 'blue';
  return (
    <ChatSystemMessage>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Token size="sm" color={color} label={formatCommandStatus(row.status)} />
        <Text type="supporting" color="secondary">
          /compact
        </Text>
        <Text type="supporting">{row.message}</Text>
        {row.instructions && (
          <Tooltip content="Compaction instructions">
            <Token size="sm" color="gray" label={row.instructions} />
          </Tooltip>
        )}
      </HStack>
    </ChatSystemMessage>
  );
}

function formatCommandStatus(status: CommandStatusRow['status']): string {
  if (status === 'compacting') {
    return 'compacting';
  }
  if (status === 'completed') {
    return 'completed';
  }
  if (status === 'failed') {
    return 'failed';
  }
  if (status === 'aborted') {
    return 'aborted';
  }
  return 'pending';
}

function RenderedMessage({
  message,
  models,
  isActionDisabled,
  onRegenerate,
  onCopy,
  onFork,
}: {
  message: ApiChatMessage;
  models: ConfiguredModel[];
  isActionDisabled: boolean;
  onRegenerate: (message: ApiChatMessage, modelId?: string) => void | Promise<void>;
  onCopy: (message: ApiChatMessage) => void | Promise<void>;
  onFork: (message: ApiChatMessage) => void | Promise<void>;
}) {
  const renderUserContentAsMarkdown = usePreferencesStore(
    state => state.renderUserContentAsMarkdown,
  );
  if (message.role === 'system') {
    return <ChatSystemMessage>{message.content}</ChatSystemMessage>;
  }

  return (
    <ChatMessage
      sender={message.role === 'assistant' ? 'assistant' : 'user'}
      avatar={message.role === 'assistant' ? <Avatar name="Nelle" size="small" /> : undefined}
    >
      {message.role === 'assistant' && message.reasoning?.trim() && (
        <ThinkingBlock
          reasoning={message.reasoning}
          isStreaming={message.isReasoning === true && !message.content.trim()}
        />
      )}
      {message.toolCalls && message.toolCalls.length > 0 && <ToolCalls calls={message.toolCalls} />}
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} />
      )}
      <ChatMessageBubble
        variant={message.role === 'assistant' ? 'ghost' : undefined}
        metadata={
          <ChatMessageMetadata
            // Assistant footers carry the timestamp in their own first row.
            // ChatMessageMetadata centers its slots on a single flex line, which
            // would strand the timestamp beside a two-row footer.
            timestamp={
              message.role === 'assistant' ? undefined : (
                <Timestamp value={message.createdAt} format="time" />
              )
            }
            footer={renderMessageFooter({
              message,
              models,
              isActionDisabled,
              onRegenerate,
              onCopy,
              onFork,
            })}
          />
        }
      >
        {message.role === 'assistant' ? (
          <AssistantMessageBody message={message} />
        ) : renderUserContentAsMarkdown ? (
          <Markdown density="compact">{message.content}</Markdown>
        ) : (
          message.content
        )}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

/**
 * An assistant turn has nothing to render only in the gap between
 * `assistant_start` and its first token. Reasoning and tool calls have their own
 * progress affordances above the bubble, so the spinner is for that gap alone --
 * which also means it cannot outlive a completed turn.
 */
function AssistantMessageBody({message}: {message: ApiChatMessage}) {
  if (message.content) {
    return <Markdown density="compact">{message.content}</Markdown>;
  }
  if (message.reasoning?.trim() || message.toolCalls?.length) {
    return null;
  }
  return <Spinner size="sm" aria-label="Waiting for the model's response" />;
}

function MessageAttachments({attachments}: {attachments: AttachmentMetadata[]}) {
  return (
    <HStack gap={1} vAlign="center" wrap="wrap" className="nelle-message-attachments">
      {attachments.map(attachment => (
        <Tooltip key={attachment.id} content={attachmentTooltip(attachment)}>
          <Token
            size="sm"
            color={
              attachment.kind === 'image' ? 'blue' : attachment.kind === 'pdf' ? 'red' : 'gray'
            }
            label={attachment.name}
            icon={
              <Icon icon={attachment.kind === 'image' ? PhotoIcon : DocumentTextIcon} size="sm" />
            }
          />
        </Tooltip>
      ))}
    </HStack>
  );
}

function renderMessageFooter(input: {
  message: ApiChatMessage;
  models: ConfiguredModel[];
  isActionDisabled: boolean;
  onRegenerate: (message: ApiChatMessage, modelId?: string) => void | Promise<void>;
  onCopy: (message: ApiChatMessage) => void | Promise<void>;
  onFork: (message: ApiChatMessage) => void | Promise<void>;
}) {
  const {message, models, isActionDisabled, onRegenerate, onCopy, onFork} = input;
  const hasPerformance = hasChatPerformance(message.performance);
  const modelLabel =
    message.role === 'assistant'
      ? (message.modelAliasSnapshot ??
        models.find(model => model.id === message.modelId)?.name ??
        message.modelRuntimeId ??
        message.modelId)
      : undefined;
  const canForkFromMessage = message.role === 'user';
  if (!hasPerformance && !modelLabel && message.role !== 'assistant' && !canForkFromMessage) {
    return undefined;
  }

  if (message.role !== 'assistant') {
    return canForkFromMessage ? (
      <HStack gap={1} vAlign="center" wrap="wrap">
        <IconButton
          label="Fork from here"
          tooltip="Fork from here"
          size="sm"
          variant="ghost"
          icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />}
          isDisabled={isActionDisabled}
          onClick={() => void onFork(message)}
        />
      </HStack>
    ) : undefined;
  }

  // Two rows, as llama.cpp's own UI does: provenance and statistics on top,
  // actions underneath. Packing all of it onto one line left no breathing room.
  return (
    <VStack gap={1} className="nelle-message-footer">
      <HStack gap={1} vAlign="center" wrap="wrap">
        <Timestamp value={message.createdAt} format="time" />
        <DropdownMenu
          button={{
            label: `Regenerate model: ${modelLabel ?? 'Unknown model'}`,
            variant: 'ghost',
            size: 'sm',
            children: modelLabel ?? 'Unknown model',
          }}
          items={models.map(model => ({
            label: model.id === message.modelId ? `Regenerate with ${model.name}` : `${model.name}`,
            onClick: () => void onRegenerate(message, model.id),
            isDisabled: isActionDisabled,
          }))}
        />
        {message.variantLabel && <Token size="sm" color="blue" label={message.variantLabel} />}
        {hasPerformance && <PerformanceStatistics performance={message.performance!} />}
      </HStack>
      <HStack gap={0.5} vAlign="center" wrap="wrap">
        <IconButton
          label="Regenerate response"
          tooltip="Regenerate response"
          size="sm"
          variant="ghost"
          icon={<Icon icon={ArrowPathIcon} size="sm" />}
          isDisabled={isActionDisabled}
          onClick={() => void onRegenerate(message, message.modelId)}
        />
        <IconButton
          label="Copy response"
          tooltip="Copy response"
          size="sm"
          variant="ghost"
          icon={<Icon icon={ClipboardDocumentIcon} size="sm" />}
          onClick={() => void onCopy(message)}
        />
      </HStack>
    </VStack>
  );
}

type StatisticsView = 'reading' | 'generation';

function PerformanceStatistics({performance}: {performance: ChatPerformance}) {
  const showGenerationStats = usePreferencesStore(state => state.showGenerationStats);
  const promptMetric = performance.prompt;
  const generationMetric = getGenerationMetric(performance);
  const hasPrompt = hasPerformanceMetric(promptMetric);
  const hasGeneration = hasPerformanceMetric(generationMetric);
  // Generation speed is what a reader cares about, so prefer it whenever it
  // exists. A message restored from a snapshot always has it; a streaming
  // message only gains it once the prompt has been processed, and until then
  // Reading is the only metric with anything to report.
  const [view, setView] = useState<StatisticsView>(() =>
    hasGeneration ? 'generation' : 'reading',
  );
  const sawGeneration = useRef(hasGeneration);

  useEffect(() => {
    if (hasGeneration && !sawGeneration.current) {
      setView('generation');
    }
    sawGeneration.current = hasGeneration;
  }, [hasGeneration]);

  useEffect(() => {
    if (view === 'generation' && !hasGeneration) {
      setView('reading');
    }
    if (view === 'reading' && !hasPrompt && hasGeneration) {
      setView('generation');
    }
  }, [hasGeneration, hasPrompt, view]);

  // Every hook above has already run: a preference must not change the hook order.
  if (!showGenerationStats) {
    return null;
  }

  const metric = view === 'generation' ? generationMetric : promptMetric;
  const metrics =
    view === 'generation'
      ? [
          {
            label: 'Generated tokens',
            value: formatTokenCount(metric?.tokens),
            icon: DocumentTextIcon,
          },
          {
            label: 'Generation time',
            value: formatMilliseconds(metric?.milliseconds),
            icon: ClockIcon,
          },
          {
            label: 'Generation speed',
            value: formatTokensPerSecond(metric?.tokensPerSecond),
            icon: ArrowTrendingUpIcon,
          },
        ]
      : [
          {
            label: 'Prompt tokens',
            value: formatTokenCount(metric?.tokens),
            icon: DocumentTextIcon,
          },
          {
            label: 'Prompt processing time',
            value: formatMilliseconds(metric?.milliseconds),
            icon: ClockIcon,
          },
          {
            label: 'Prompt processing speed',
            value: formatTokensPerSecond(metric?.tokensPerSecond),
            icon: ArrowTrendingUpIcon,
          },
        ];

  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      <HStack gap={0.5} vAlign="center">
        <IconButton
          label="Reading (prompt processing)"
          tooltip="Reading (prompt processing)"
          size="sm"
          variant={view === 'reading' ? 'primary' : 'ghost'}
          icon={<Icon icon={BookOpenIcon} size="sm" />}
          isDisabled={!hasPrompt}
          onClick={() => setView('reading')}
        />
        <IconButton
          label="Generation (token output)"
          tooltip="Generation (token output)"
          size="sm"
          variant={view === 'generation' ? 'primary' : 'ghost'}
          icon={<Icon icon={SparklesIcon} size="sm" />}
          isDisabled={!hasGeneration}
          onClick={() => setView('generation')}
        />
      </HStack>
      <HStack gap={0.5} vAlign="center" wrap="wrap">
        {metrics.map(item => (
          <Tooltip key={item.label} content={item.label}>
            <Token
              size="sm"
              color="gray"
              label={item.value}
              icon={<Icon icon={item.icon} size="sm" />}
            />
          </Tooltip>
        ))}
      </HStack>
    </HStack>
  );
}

/**
 * The server already applied the rules: replayed user turns hidden, ghost
 * assistant entries dropped, regenerate variants grouped and labelled. They live
 * in `packages/shared/src/messages.ts` so a React Native client renders exactly
 * what this one does.
 */
function messagesFromSnapshot(snapshot: ConversationSnapshot): ApiChatMessage[] {
  return snapshot.messages as ApiChatMessage[];
}

function ToolCalls({calls}: {calls: NonNullable<ApiChatMessage['toolCalls']>}) {
  const showToolCallsInProgress = usePreferencesStore(state => state.showToolCallsInProgress);
  const isRunning = calls.some(call => call.status === 'running');
  return (
    <ChatToolCalls
      // Uncontrolled: the reader may fold it away again, and should stay folded.
      defaultIsExpanded={isRunning && showToolCallsInProgress}
      calls={calls.map(call => ({
        ...call,
        key: call.id,
        resultDetail: renderToolCallDetail(call),
      }))}
    />
  );
}

function renderToolCallDetail(call: NonNullable<ApiChatMessage['toolCalls']>[number]) {
  const sections = [
    call.input ? {label: 'Input', value: call.input} : null,
    call.output
      ? {label: call.status === 'error' ? 'Error output' : 'Output', value: call.output}
      : null,
  ].filter(section => section != null);

  if (sections.length === 0) {
    return undefined;
  }

  return (
    <VStack gap={2} className="nelle-tool-detail">
      {sections.map(section => (
        <VStack key={section.label} gap={1}>
          <Text type="supporting" color="secondary">
            {section.label}
          </Text>
          <CodeBlock
            code={section.value}
            language={looksLikeJson(section.value) ? 'json' : 'text'}
            width="100%"
            maxHeight="calc(var(--spacing-10) * 6)"
            isWrapped
          />
        </VStack>
      ))}
    </VStack>
  );
}

function hasChatPerformance(performance: ChatPerformance | undefined): boolean {
  if (!performance) {
    return false;
  }
  return (
    hasPerformanceMetric(performance.prompt) ||
    hasPerformanceMetric(getGenerationMetric(performance))
  );
}

function getGenerationMetric(performance: ChatPerformance): ChatPerformanceMetric | undefined {
  return (
    performance.generation ??
    (performance.tokensPerSecond == null
      ? undefined
      : {
          tokens: performance.generatedTokens ?? 0,
          tokensPerSecond: performance.tokensPerSecond,
        })
  );
}

function hasPerformanceMetric(metric: ChatPerformanceMetric | undefined): boolean {
  return Boolean(
    metric &&
    (Number.isFinite(metric.tokens) ||
      Number.isFinite(metric.milliseconds) ||
      Number.isFinite(metric.tokensPerSecond)),
  );
}

function formatTokenCount(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  const rounded = Math.max(0, Math.round(value));
  return `${rounded.toLocaleString()} ${rounded === 1 ? 'token' : 'tokens'}`;
}

function formatMilliseconds(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  if (value < 1000) {
    return `${Math.max(0, value).toFixed(0)}ms`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function formatTokensPerSecond(value: number | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return '--';
  }
  return `${value.toFixed(2)} t/s`;
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function normalizeComposerValue(value: string): string {
  return value.replace(/\u00a0/g, ' ').trim();
}

function createCompactCommandRow(conversationId: string, instructions: string): CommandStatusRow {
  const now = new Date().toISOString();
  return {
    id: `compact:${now}:${Math.random().toString(36).slice(2)}`,
    conversationId,
    kind: 'compact',
    status: 'pending',
    instructions,
    message: 'Queued context compaction.',
    createdAt: now,
  };
}

/** Favorites starred before they moved to the server. Read once, then dropped. */
function readLegacyFavoriteModelIds(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const rawValue = window.localStorage.getItem(FAVORITE_MODEL_IDS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }
    const parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function clearLegacyFavoriteModelIds(): void {
  try {
    window.localStorage.removeItem(FAVORITE_MODEL_IDS_STORAGE_KEY);
  } catch {
    // Storage may be blocked. The favorites are already on the server.
  }
}

function archiveFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'nelle-chat'}.nelle-chat.zip`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function copyMessageText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = value;
  textArea.style.position = 'fixed';
  textArea.style.opacity = '0';
  document.body.append(textArea);
  textArea.select();
  const didCopy = document.execCommand('copy');
  textArea.remove();
  if (!didCopy) {
    throw new Error('Could not copy response.');
  }
}
