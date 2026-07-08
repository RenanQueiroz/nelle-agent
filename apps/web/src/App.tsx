import {type ChangeEvent, useEffect, useMemo, useRef, useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';

import {AppShell} from '@astryxdesign/core/AppShell';
import {HStack, VStack, StackItem, Layout, LayoutContent} from '@astryxdesign/core/Layout';
import {Text, Heading} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  ChatLayout,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatSystemMessage,
  ChatToolCalls,
  type ChatComposerTrigger,
} from '@astryxdesign/core/Chat';
import {Markdown} from '@astryxdesign/core/Markdown';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {TextInput} from '@astryxdesign/core/TextInput';
import {createStaticSource, TypeaheadItem, type SearchableItem} from '@astryxdesign/core/Typeahead';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {Timestamp} from '@astryxdesign/core/Timestamp';
import {Token} from '@astryxdesign/core/Token';
import {Tooltip} from '@astryxdesign/core/Tooltip';
import {useToast} from '@astryxdesign/core/Toast';
import {Avatar} from '@astryxdesign/core/Avatar';
import {Icon} from '@astryxdesign/core/Icon';
import {StatusDot} from '@astryxdesign/core/StatusDot';
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowTrendingUpIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  ClockIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  MagnifyingGlassIcon,
  PaperClipIcon,
  PhotoIcon,
  PlusIcon,
  PlayIcon,
  SparklesIcon,
  StopIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import {
  abortConversationCompaction,
  abortConversation,
  abortConversationRun,
  activateModel,
  clearConversation,
  cloneConversation,
  compactConversation,
  createConversation,
  deleteConversation,
  deleteAllConversations,
  deleteConfiguredModel,
  duplicateConfiguredModel,
  exportConversationArchive,
  forkConversation,
  getConversation,
  getConversations,
  getLlamaModelProps,
  getLlamaModels,
  getRuntime,
  getRuntimeLogs,
  getState,
  importConversationArchive,
  installRuntime,
  loadLlamaModel,
  reloadLlamaModels,
  searchHuggingFace,
  setConversationPinned,
  startRuntime,
  stopRuntime,
  streamConversationChat,
  streamRegenerateMessage,
  unloadLlamaModel,
  updateConversation,
  updateConfiguredModel,
  updateGlobalModelParams,
  updateRuntimeSettings,
  useHuggingFaceModel,
  type ChatMessage as ApiChatMessage,
  type AttachmentMetadata,
  type ChatAttachmentInput,
  type ChatPerformance,
  type ChatPerformanceMetric,
  type ChatStreamEvent,
  type ConfiguredModel,
  type ConversationContextUsage,
  type ConversationListItem,
  type ConversationSnapshot,
  type HuggingFaceModelResult,
  type LlamaModelProps,
  type LlamaRouterModel,
  type RuntimeStatus,
} from './api';

const ATTACHMENT_LIMITS = {
  maxFiles: 10,
  maxFileBytes: 25 * 1024 * 1024,
  maxDraftBytes: 100 * 1024 * 1024,
  maxTextCharacters: 200_000,
};

type DraftAttachment = ChatAttachmentInput & {
  warning?: string;
};

type SettingsSection = 'runtime' | 'models' | 'global' | 'chats';

type ParamRow = {
  id: string;
  key: string;
  value: string;
};

const formatBytes = (value: number | null) => {
  if (value == null) {
    return 'unknown size';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size > 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

type SlashCommandData = {
  description: string;
};

const SUPPORTED_SLASH_COMMANDS: SearchableItem<SlashCommandData>[] = [
  {
    id: 'compact',
    label: 'compact',
    auxiliaryData: {
      description: 'Compact this conversation context',
    },
  },
];

const slashCommandSource = createStaticSource(SUPPORTED_SLASH_COMMANDS);

const slashCommandTrigger: ChatComposerTrigger = {
  character: '/',
  searchSource: slashCommandSource,
  renderItem: item => (
    <TypeaheadItem
      item={item}
      description={(item.auxiliaryData as SlashCommandData | undefined)?.description}
    />
  ),
  onSelect: item => ({
    value: `/${item.label}`,
    label: `/${item.label}`,
    variant: 'yellow' as const,
  }),
  emptySearchResultsText: 'Only /compact is supported in Nelle chat.',
  menuLabel: 'Nelle slash commands',
};

function findRouterModelForConfiguredModel(
  model: ConfiguredModel,
  routerModels: LlamaRouterModel[],
): LlamaRouterModel | undefined {
  return routerModels.find(
    routerModel =>
      routerModel.sectionId === model.id ||
      routerModel.routerModelId === model.id ||
      routerModel.hfRepo === model.hfRef ||
      routerModel.aliases.includes(model.id) ||
      (model.hfRef != null && routerModel.aliases.includes(model.hfRef)),
  );
}

function formatRouterStatus(status: string): string {
  if (status === 'stopped') {
    return 'router stopped';
  }
  return status.replace(/_/g, ' ');
}

function routerStatusColor(status: string): 'green' | 'yellow' | 'red' | 'blue' {
  if (status === 'loaded' || status === 'sleeping') {
    return 'green';
  }
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'loading' || status === 'unloaded') {
    return 'yellow';
  }
  return 'blue';
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

function isRunnableRouterStatus(status: string | null | undefined): boolean {
  return status === 'loaded' || status === 'sleeping';
}

export function App() {
  const showToast = useToast();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [routerModels, setRouterModels] = useState<LlamaRouterModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [activeModelProps, setActiveModelProps] = useState<LlamaModelProps | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('poc-default');
  const [messages, setMessages] = useState<ApiChatMessage[]>([]);
  const [commandRows, setCommandRows] = useState<CommandStatusRow[]>([]);
  const [contextUsage, setContextUsage] = useState<ConversationContextUsage>({});
  const [conversationSearch, setConversationSearch] = useState('');
  const [composerDraft, setComposerDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [slashCommandError, setSlashCommandError] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerWarning, setComposerWarning] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('qwen gguf');
  const [searchResults, setSearchResults] = useState<HuggingFaceModelResult[]>([]);
  const [modelsMaxInput, setModelsMaxInput] = useState('1');
  const [sleepIdleInput, setSleepIdleInput] = useState('90');
  const [isLogVisible, setIsLogVisible] = useState(false);
  const [runtimeLogs, setRuntimeLogs] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('runtime');
  const [globalParamRows, setGlobalParamRows] = useState<ParamRow[]>(() =>
    paramsToRows({c: '8192'}),
  );
  const [modelParamRows, setModelParamRows] = useState<Record<string, ParamRow[]>>({});
  const [modelAliasDrafts, setModelAliasDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [activeRunIds, setActiveRunIds] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const archiveInputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortController = useRef<AbortController | null>(null);
  const compactAbortController = useRef<AbortController | null>(null);
  const [notice, setNotice] = useState<{
    type: 'info' | 'warning' | 'error' | 'success';
    text: string;
  } | null>(null);

  const activeModel = useMemo(
    () => models.find(model => model.id === activeModelId) ?? null,
    [activeModelId, models],
  );
  const activeCommandRows = useMemo(
    () => commandRows.filter(row => row.conversationId === activeConversationId),
    [activeConversationId, commandRows],
  );
  const displayedContextUsage = useMemo(
    () =>
      mergeContextTotals(
        contextUsage,
        activeModelProps?.contextWindow ?? activeModel?.params.contextSize,
      ),
    [activeModel?.params.contextSize, activeModelProps?.contextWindow, contextUsage],
  );
  const composerBlockingMessage = useMemo(() => {
    if (slashCommandError) {
      return slashCommandError;
    }
    if (composerError) {
      return composerError;
    }
    const attachmentError = getDraftAttachmentError(draftAttachments, activeModelProps);
    if (attachmentError) {
      return attachmentError;
    }
    if (!runtime?.running) {
      return 'Start llama.cpp before chatting.';
    }
    if (!activeModel) {
      return 'Select a GGUF model before chatting.';
    }
    return getContextOverflowMessage(displayedContextUsage);
  }, [
    activeModel,
    activeModelProps,
    composerError,
    displayedContextUsage,
    draftAttachments,
    runtime?.running,
    slashCommandError,
  ]);
  const composerWarningMessage =
    composerBlockingMessage == null
      ? (composerWarning ?? getContextWarningMessage(displayedContextUsage))
      : null;
  const composerStatus = useMemo(() => {
    if (composerBlockingMessage) {
      return {type: 'error' as const, message: composerBlockingMessage};
    }
    if (composerWarningMessage) {
      return {type: 'warning' as const, message: composerWarningMessage};
    }
    return undefined;
  }, [composerBlockingMessage, composerWarningMessage]);
  const composerStatusPosition = composerBlockingMessage ? 'top' : 'bottom';
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
  useEffect(() => {
    let isCancelled = false;
    void (async () => {
      const response = await getState();
      if (isCancelled) {
        return;
      }
      setRuntime(response.runtime);
      setModelsMaxInput(
        String(response.runtime.modelsMax ?? response.state.runtime?.modelsMax ?? 1),
      );
      setSleepIdleInput(
        String(response.runtime.sleepIdleSeconds ?? response.state.runtime?.sleepIdleSeconds ?? 90),
      );
      setModels(response.state.models);
      setActiveModelId(response.state.activeModelId);
      syncSettingsDrafts(response.state.globalModelParams, response.state.models);
      try {
        const list = await getConversations();
        if (isCancelled) {
          return;
        }
        setConversations(list);
        const conversationId = list.find(conversation => conversation.id === 'poc-default')?.id;
        const nextConversationId = conversationId ?? list[0]?.id ?? 'poc-default';
        setActiveConversationId(nextConversationId);
        const snapshot = await getConversation(nextConversationId);
        if (!isCancelled) {
          applyConversationSnapshot(snapshot, setMessages, setContextUsage);
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
        } catch {
          if (!isCancelled) {
            setRouterModels([]);
          }
        }
      } else {
        setRouterModels([]);
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    let isCancelled = false;
    setActiveModelProps(null);
    if (!activeModel || !runtime?.running || !isRunnableRouterStatus(activeComposerRouterStatus)) {
      return () => {
        isCancelled = true;
      };
    }
    void (async () => {
      try {
        const props = await getLlamaModelProps(activeModel.id);
        if (!isCancelled) {
          setActiveModelProps(props);
        }
      } catch {
        if (!isCancelled) {
          setActiveModelProps(null);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, [activeComposerRouterStatus, activeModel, runtime?.running]);

  function syncSettingsDrafts(
    globalParams: Record<string, string> | undefined,
    nextModels: ConfiguredModel[],
  ) {
    setGlobalParamRows(paramsToRows(globalParams ?? {c: '8192'}));
    setModelParamRows(
      Object.fromEntries(
        nextModels.map(model => [model.id, paramsToRows(model.params.extra ?? {})]),
      ),
    );
    setModelAliasDrafts(Object.fromEntries(nextModels.map(model => [model.id, model.name])));
  }

  async function refreshState() {
    const response = await getState();
    setRuntime(response.runtime);
    setModelsMaxInput(String(response.runtime.modelsMax ?? response.state.runtime?.modelsMax ?? 1));
    setSleepIdleInput(
      String(response.runtime.sleepIdleSeconds ?? response.state.runtime?.sleepIdleSeconds ?? 90),
    );
    setModels(response.state.models);
    setActiveModelId(response.state.activeModelId);
    syncSettingsDrafts(response.state.globalModelParams, response.state.models);
    await refreshConversations(activeConversationId, response.state.chat);
    if (response.runtime.running) {
      await refreshRouterModels({silent: true});
    } else {
      setRouterModels([]);
    }
  }

  async function refreshConversations(
    preferredConversationId = activeConversationId,
    fallbackMessages: ApiChatMessage[] = [],
  ): Promise<void> {
    try {
      const list = await getConversations();
      setConversations(list);
      const nextConversationId =
        list.find(conversation => conversation.id === preferredConversationId)?.id ??
        list[0]?.id ??
        preferredConversationId;
      setActiveConversationId(nextConversationId);
      const snapshot = await getConversation(nextConversationId);
      applyConversationSnapshot(snapshot, setMessages, setContextUsage);
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
    } catch (error) {
      setRouterModels([]);
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
    setIsSearching(true);
    setNotice(null);
    try {
      setSearchResults(await searchHuggingFace(searchQuery));
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSearching(false);
    }
  }

  async function handleSaveRuntimeSettings() {
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
      await updateRuntimeSettings({modelsMax, sleepIdleSeconds});
      await refreshState();
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Runtime settings saved. Restart llama.cpp to apply them.'
          : 'Runtime settings saved.',
      });
    });
  }

  async function handleSaveGlobalParams() {
    await runAction('global-params', async () => {
      await updateGlobalModelParams(rowsToParams(globalParamRows));
      await refreshState();
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Global params saved and router models reloaded.'
          : 'Global params saved. Restart llama.cpp if it is already running elsewhere.',
      });
    });
  }

  async function handleSaveModelSettings(model: ConfiguredModel) {
    await runAction(`model-save:${model.id}`, async () => {
      await updateConfiguredModel(model.id, {
        name: modelAliasDrafts[model.id] ?? model.name,
        params: rowsToParams(modelParamRows[model.id] ?? []),
      });
      await refreshState();
      setNotice({
        type: 'success',
        text: runtime?.running
          ? 'Model settings saved and router models reloaded.'
          : 'Model settings saved.',
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

  async function handleToggleLogs() {
    await runAction('runtime-logs', async () => {
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
    if (model.id === activeModelId) {
      return;
    }
    await runAction(`composer-model:${model.id}`, async () => {
      if (runtime?.running) {
        await waitForRouterModelReady(model);
      }
      const activatedModel = await activateModel(model.id);
      setActiveModelId(activatedModel.id);
      await refreshState();
    });
  }

  function handleComposerDraftChange(value: string) {
    setComposerDraft(value);
    if (slashCommandError) {
      setSlashCommandError(null);
    }
    if (composerError) {
      setComposerError(null);
    }
  }

  async function handleComposerFiles(files: File[]) {
    setComposerError(null);
    setComposerWarning(null);
    try {
      const result = await prepareDraftAttachments(files, {
        existing: draftAttachments,
        canAttachImages: activeModelProps?.modalities.vision === true,
      });
      if (result.attachments.length > 0) {
        setDraftAttachments(prev => [...prev, ...result.attachments]);
      }
      if (result.warning) {
        setComposerWarning(result.warning);
      }
    } catch (error) {
      setComposerError(error instanceof Error ? error.message : String(error));
    }
  }

  function handleRemoveDraftAttachment(id: string) {
    setDraftAttachments(prev => prev.filter(attachment => attachment.id !== id));
    if (composerError) {
      setComposerError(null);
    }
  }

  function handleFilePickerChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (files.length > 0) {
      void handleComposerFiles(files);
    }
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
    if (!prompt || isStreaming || isCompacting) {
      return;
    }
    const compactInstructions = parseCompactCommand(prompt);
    if (compactInstructions != null) {
      await handleCompactConversation(compactInstructions);
      return;
    }
    const unsupportedSlashCommand = getUnsupportedSlashCommandMessage(prompt);
    if (unsupportedSlashCommand) {
      setSlashCommandError(unsupportedSlashCommand);
      restoreComposerDraft(prompt, setComposerDraft);
      return;
    }
    const contextOverflow = getContextOverflowMessage(displayedContextUsage);
    if (contextOverflow) {
      setComposerError(`${contextOverflow} Run /compact to make room before sending.`);
      restoreComposerDraft(prompt, setComposerDraft);
      return;
    }
    const attachmentError = getDraftAttachmentError(draftAttachments, activeModelProps);
    if (attachmentError) {
      setComposerError(attachmentError);
      restoreComposerDraft(prompt, setComposerDraft);
      return;
    }
    setIsStreaming(true);
    setNotice(null);
    setComposerError(null);
    setComposerWarning(null);
    const abortController = new AbortController();
    streamAbortController.current = abortController;
    try {
      await streamConversationChat(
        activeConversationId,
        prompt,
        applyChatEvent,
        abortController.signal,
        draftAttachments,
      );
      setDraftAttachments([]);
      setRuntime(await getRuntime());
      await refreshConversations(activeConversationId);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (streamAbortController.current === abortController) {
        streamAbortController.current = null;
      }
      setIsStreaming(false);
    }
  }

  async function handleCompactConversation(instructions: string) {
    const commandRow = createCompactCommandRow(activeConversationId, instructions);
    setCommandRows(prev => [...prev, commandRow]);
    setIsCompacting(true);
    setSlashCommandError(null);
    setComposerError(null);
    setComposerWarning(null);
    updateCommandRow(commandRow.id, {
      status: 'compacting',
      message: 'Compacting conversation context...',
    });
    const abortController = new AbortController();
    compactAbortController.current = abortController;
    try {
      const result = await compactConversation(
        activeConversationId,
        instructions || undefined,
        abortController.signal,
      );
      applyConversationSnapshot(result.snapshot, setMessages, setContextUsage);
      await refreshConversations(activeConversationId);
      updateCommandRow(commandRow.id, {
        status: 'completed',
        message: 'Conversation compacted.',
        completedAt: new Date().toISOString(),
      });
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
      setComposerError(message);
    } finally {
      if (compactAbortController.current === abortController) {
        compactAbortController.current = null;
      }
      setIsCompacting(false);
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
      setDraftAttachments([]);
      await refreshConversations(created.id);
    });
  }

  async function handleSelectConversation(conversationId: string) {
    setSlashCommandError(null);
    setComposerError(null);
    setComposerWarning(null);
    setDraftAttachments([]);
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

  async function handleDeleteConversation(conversation: ConversationListItem) {
    if (!window.confirm(`Delete "${conversation.title}"?`)) {
      return;
    }
    await runAction(`delete:${conversation.id}`, async () => {
      await deleteConversation(conversation.id);
      if (conversation.id === activeConversationId) {
        setMessages([]);
        setContextUsage({});
      }
      await refreshConversations(activeConversationId);
    });
  }

  async function handleClearAllConversations() {
    if (!window.confirm('Delete all conversations and their local session files?')) {
      return;
    }
    await runAction('clear-all-chats', async () => {
      await deleteAllConversations();
      setMessages([]);
      setContextUsage({});
      await refreshConversations('poc-default');
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
      applyConversationSnapshot(snapshot, setMessages, setContextUsage);
      setDraftAttachments([]);
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation imported.'});
    });
  }

  async function handleCloneConversation(conversation: ConversationListItem) {
    await runAction(`clone:${conversation.id}`, async () => {
      const snapshot = await cloneConversation(conversation.id);
      setActiveConversationId(snapshot.conversation.id);
      applyConversationSnapshot(snapshot, setMessages, setContextUsage);
      setDraftAttachments([]);
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation duplicated.'});
    });
  }

  async function handleForkMessage(message: ApiChatMessage) {
    if (message.role !== 'user' || isStreaming || isCompacting) {
      return;
    }
    await runAction(`fork:${message.id}`, async () => {
      const snapshot = await forkConversation(activeConversationId, message.id);
      setActiveConversationId(snapshot.conversation.id);
      applyConversationSnapshot(snapshot, setMessages, setContextUsage);
      setDraftAttachments([]);
      await refreshConversations(snapshot.conversation.id);
      setNotice({type: 'success', text: 'Conversation forked.'});
    });
  }

  async function handleStopGeneration() {
    await runAction('abort-chat', async () => {
      const runId = activeRunIds[activeConversationId];
      if (runId) {
        await abortConversationRun(activeConversationId, runId);
      } else {
        await abortConversation(activeConversationId);
      }
      setIsStreaming(false);
      await refreshConversations(activeConversationId);
      setNotice({type: 'info', text: 'Generation stopped.'});
    });
  }

  async function handleStopCompaction() {
    compactAbortController.current?.abort();
    await runAction('abort-compaction', async () => {
      await abortConversationCompaction(activeConversationId);
      updateActiveCompactionRows({
        status: 'aborted',
        message: 'Compaction stopped.',
        completedAt: new Date().toISOString(),
      });
      setIsCompacting(false);
      await refreshConversations(activeConversationId);
      setNotice({type: 'info', text: 'Compaction stopped.'});
    });
  }

  async function ensureModelReadyForRun(modelId: string): Promise<void> {
    const model = models.find(item => item.id === modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }
    if (!runtime?.running) {
      throw new Error('Start llama.cpp before regenerating a response.');
    }
    await waitForRouterModelReady(model);
  }

  async function waitForRouterModelReady(model: ConfiguredModel): Promise<void> {
    const currentRouterModel = findRouterModelForConfiguredModel(model, routerModels);
    if (isRunnableRouterStatus(currentRouterModel?.status)) {
      return;
    }

    if (currentRouterModel?.status !== 'loading') {
      await loadLlamaModel(model.id);
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const nextRouterModels = await getLlamaModels();
      setRouterModels(nextRouterModels);
      const nextRouterModel = findRouterModelForConfiguredModel(model, nextRouterModels);
      if (isRunnableRouterStatus(nextRouterModel?.status)) {
        return;
      }
      if (nextRouterModel?.status === 'failed') {
        throw new Error(`${model.name} failed to load. Check the llama.cpp logs.`);
      }
      await delay(500);
    }
    throw new Error(`${model.name} did not finish loading before the router timed out.`);
  }

  async function handleRegenerateMessage(message: ApiChatMessage, modelId?: string) {
    if (message.role !== 'assistant' || isStreaming || isCompacting) {
      return;
    }
    const selectedModelId = modelId ?? message.modelId ?? activeModelId;
    if (!selectedModelId) {
      setNotice({type: 'error', text: 'Select a model before regenerating a response.'});
      return;
    }

    setIsStreaming(true);
    setNotice(null);
    setComposerError(null);
    setComposerWarning(null);
    const abortController = new AbortController();
    streamAbortController.current = abortController;
    try {
      await ensureModelReadyForRun(selectedModelId);
      await streamRegenerateMessage(
        activeConversationId,
        message.id,
        selectedModelId,
        applyChatEvent,
        abortController.signal,
      );
      setRuntime(await getRuntime());
      await refreshConversations(activeConversationId);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setComposerError(error instanceof Error ? error.message : String(error));
    } finally {
      if (streamAbortController.current === abortController) {
        streamAbortController.current = null;
      }
      setIsStreaming(false);
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

  function applyChatEvent(event: ChatStreamEvent) {
    if (event.type === 'run.started') {
      setActiveRunIds(previous => ({...previous, [event.conversationId]: event.runId}));
    }
    if (event.type === 'run.aborted') {
      setComposerWarning('Generation stopped.');
    }
    if (event.type === 'run.completed') {
      setActiveRunIds(previous => {
        if (previous[event.conversationId] !== event.runId) {
          return previous;
        }
        const next = {...previous};
        delete next[event.conversationId];
        return next;
      });
      if (event.status === 'failed' && event.error?.message) {
        setComposerError(event.error.message);
      }
    }
    if (event.type === 'user_message') {
      setMessages(prev => [...prev, event.message]);
    }
    if (event.type === 'assistant_start') {
      setMessages(prev => [...prev, event.message]);
    }
    if (event.type === 'assistant_delta') {
      setMessages(prev =>
        prev.map(message =>
          message.id === event.id ? {...message, content: message.content + event.delta} : message,
        ),
      );
    }
    if (event.type === 'assistant_metrics') {
      const nextContext = contextUsageFromPerformance(
        event.performance,
        activeModelProps?.contextWindow ?? activeModel?.params.contextSize,
      );
      if (nextContext) {
        setContextUsage(previous => mergeLiveContextUsage(previous, nextContext));
      }
      setMessages(prev =>
        prev.map(message =>
          message.id === event.id
            ? {
                ...message,
                performance: mergeChatPerformance(message.performance, event.performance),
              }
            : message,
        ),
      );
    }
    if (event.type === 'tool') {
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
    if (event.type === 'warning') {
      setComposerWarning(event.message);
    }
    if (event.type === 'conversation_title') {
      setConversations(prev =>
        prev.map(conversation =>
          conversation.id === event.conversationId
            ? {...conversation, title: event.title, titleSource: 'generated'}
            : conversation,
        ),
      );
    }
    if (event.type === 'done') {
      setMessages(prev =>
        prev.map(message => (message.id === event.message.id ? event.message : message)),
      );
    }
    if (event.type === 'error') {
      setComposerError(event.message);
    }
  }

  const runtimeTone = runtime?.running ? 'green' : runtime?.installed ? 'yellow' : 'blue';

  return (
    <AppShell contentPadding={0} height="fill" variant="surface">
      <Layout
        height="fill"
        content={
          <LayoutContent padding={0}>
            <HStack height="100%" className="nelle-workbench">
              <VStack
                gap={4}
                className={
                  isSidebarCollapsed
                    ? 'nelle-side-panel nelle-side-panel-collapsed'
                    : 'nelle-side-panel nelle-panel-content nelle-scroll'
                }
              >
                {isSidebarCollapsed ? (
                  <CollapsedSidebar
                    onExpand={() => setIsSidebarCollapsed(false)}
                    onOpenSettings={() => {
                      setIsSidebarCollapsed(false);
                      setIsSettingsOpen(true);
                    }}
                    onNewConversation={handleNewConversation}
                    isNewConversationBusy={busyAction === 'new-chat'}
                  />
                ) : (
                  <>
                    <HStack gap={2} vAlign="center">
                      <Icon icon={ChatBubbleLeftRightIcon} size="md" color="accent" />
                      <VStack gap={0}>
                        <Heading level={2}>Nelle Agent</Heading>
                        <Text type="supporting" color="secondary">
                          Local Pi + llama.cpp POC
                        </Text>
                      </VStack>
                      <StackItem size="fill" />
                      <IconButton
                        label="Settings"
                        tooltip="Settings"
                        size="sm"
                        variant={isSettingsOpen ? 'secondary' : 'ghost'}
                        icon={<Icon icon={Cog6ToothIcon} size="sm" />}
                        onClick={() => setIsSettingsOpen(value => !value)}
                      />
                      <IconButton
                        label="Collapse sidebar"
                        tooltip="Collapse sidebar"
                        size="sm"
                        variant="ghost"
                        icon={<Icon icon={ChevronLeftIcon} size="sm" />}
                        onClick={() => setIsSidebarCollapsed(true)}
                      />
                    </HStack>

                    {notice && (
                      <Banner
                        status={notice.type}
                        title={notice.text}
                        isDismissable
                        onDismiss={() => setNotice(null)}
                      />
                    )}

                    <Card padding={3}>
                      <VStack gap={3}>
                        <HStack gap={2} vAlign="center">
                          <StackItem size="fill">
                            <Heading level={3}>Conversations</Heading>
                          </StackItem>
                          <Button
                            label="New chat"
                            size="sm"
                            variant="secondary"
                            icon={<Icon icon={PlusIcon} size="sm" />}
                            isLoading={busyAction === 'new-chat'}
                            onClick={handleNewConversation}
                          />
                          <Button
                            label="Import"
                            size="sm"
                            variant="ghost"
                            icon={<Icon icon={ArrowUpTrayIcon} size="sm" />}
                            isLoading={busyAction === 'import-chat'}
                            onClick={() => archiveInputRef.current?.click()}
                          />
                          <input
                            ref={archiveInputRef}
                            aria-label="Import conversation archive"
                            className="nelle-hidden-file-input"
                            type="file"
                            accept=".nelle-chat.zip,application/zip"
                            onChange={handleArchivePickerChange}
                          />
                        </HStack>
                        <TextInput
                          label="Search conversations"
                          value={conversationSearch}
                          onChange={setConversationSearch}
                          placeholder="Search chats"
                        />
                        <ConversationVirtualList
                          conversations={conversations}
                          query={conversationSearch}
                          activeConversationId={activeConversationId}
                          onSelect={handleSelectConversation}
                          onTogglePin={handleToggleConversationPin}
                          onRename={handleRenameConversation}
                          onReset={handleResetConversation}
                          onExport={handleExportConversation}
                          onClone={handleCloneConversation}
                          onDelete={handleDeleteConversation}
                        />
                      </VStack>
                    </Card>
                  </>
                )}
              </VStack>

              <StackItem size="fill" className="nelle-chat-column">
                <ChatLayout
                  data-testid="chat-layout"
                  className="nelle-chat-layout"
                  density="spacious"
                  composer={
                    <ChatComposer
                      onSubmit={handleChatSubmit}
                      value={composerDraft}
                      onChange={handleComposerDraftChange}
                      placeholder={
                        activeModel
                          ? 'Ask Nelle to inspect files, run shell commands, or reason about the project'
                          : 'Select a GGUF model before chatting'
                      }
                      isDisabled={!activeModel || !runtime?.running || isStreaming || isCompacting}
                      isStopShown={isStreaming || isCompacting}
                      onStop={() =>
                        void (isCompacting ? handleStopCompaction() : handleStopGeneration())
                      }
                      headerActions={
                        <HStack gap={1} vAlign="center">
                          <IconButton
                            label="Attach files"
                            tooltip="Attach files"
                            size="sm"
                            variant="ghost"
                            icon={<Icon icon={PaperClipIcon} size="sm" />}
                            isDisabled={isStreaming || isCompacting}
                            onClick={() => fileInputRef.current?.click()}
                          />
                          <input
                            ref={fileInputRef}
                            aria-label="Attach files"
                            className="nelle-hidden-file-input"
                            type="file"
                            multiple
                            accept="text/*,.txt,.md,.json,.csv,.log,.pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif"
                            onChange={handleFilePickerChange}
                          />
                        </HStack>
                      }
                      headerContext={<ContextWindowUsage context={displayedContextUsage} />}
                      drawer={
                        draftAttachments.length > 0 ? (
                          <AttachmentDrawer
                            attachments={draftAttachments}
                            onRemove={handleRemoveDraftAttachment}
                          />
                        ) : undefined
                      }
                      input={
                        <ChatComposerInput
                          triggers={[slashCommandTrigger]}
                          onFiles={files => void handleComposerFiles(files)}
                        />
                      }
                      status={composerStatus}
                      statusPosition={composerStatusPosition}
                      footerActions={
                        <HStack gap={1} vAlign="center" wrap="wrap">
                          <DropdownMenu
                            button={{
                              label: activeModel?.name ?? 'No model',
                              variant: 'ghost',
                              size: 'sm',
                              children: activeModel?.name ?? 'No model',
                            }}
                            items={models.map(model => ({
                              label: model.name,
                              onClick: () => void handleSelectComposerModel(model),
                            }))}
                          />
                          {activeComposerRouterStatus && (
                            <Tooltip content="Selected model router status">
                              <Token
                                size="sm"
                                color={routerStatusColor(activeComposerRouterStatus)}
                                label={formatRouterStatus(activeComposerRouterStatus)}
                              />
                            </Tooltip>
                          )}
                          <Tooltip content="Supported command: compact this conversation context">
                            <Token size="sm" color="yellow" label="/compact" />
                          </Tooltip>
                        </HStack>
                      }
                    />
                  }
                >
                  <ChatMessageList>
                    {messages.length === 0 && (
                      <ChatSystemMessage>
                        Install llama.cpp, add a GGUF model, start the server, then ask Nelle to
                        work on this PC.
                      </ChatSystemMessage>
                    )}
                    {messages.map(message => (
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
                    {activeCommandRows.map(row => (
                      <CommandStatusMessage key={row.id} row={row} />
                    ))}
                  </ChatMessageList>
                </ChatLayout>
              </StackItem>

              {isSettingsOpen && (
                <SettingsPanel
                  section={settingsSection}
                  onSectionChange={setSettingsSection}
                  onClose={() => setIsSettingsOpen(false)}
                  runtime={runtime}
                  runtimeTone={runtimeTone}
                  runtimeLogs={runtimeLogs}
                  isLogVisible={isLogVisible}
                  modelsMaxInput={modelsMaxInput}
                  sleepIdleInput={sleepIdleInput}
                  onModelsMaxInputChange={setModelsMaxInput}
                  onSleepIdleInputChange={setSleepIdleInput}
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
                  modelAliasDrafts={modelAliasDrafts}
                  modelParamRows={modelParamRows}
                  onModelAliasChange={(modelId, value) =>
                    setModelAliasDrafts(previous => ({...previous, [modelId]: value}))
                  }
                  onModelParamRowsChange={(modelId, rows) =>
                    setModelParamRows(previous => ({...previous, [modelId]: rows}))
                  }
                  onSaveModel={handleSaveModelSettings}
                  onDuplicateModel={handleDuplicateConfiguredModel}
                  onDeleteModel={handleDeleteConfiguredModel}
                  globalParamRows={globalParamRows}
                  onGlobalParamRowsChange={setGlobalParamRows}
                  onSaveGlobalParams={handleSaveGlobalParams}
                  searchQuery={searchQuery}
                  searchResults={searchResults}
                  isSearching={isSearching}
                  onSearchQueryChange={setSearchQuery}
                  onSearch={handleSearch}
                  onUseHuggingFaceModel={(repoId, quant) =>
                    runAction(`use:${repoId}:${quant}`, async () => {
                      await useHuggingFaceModel({repoId, quant});
                      await refreshState();
                    })
                  }
                  conversations={conversations}
                  onImportConversation={() => archiveInputRef.current?.click()}
                  isImporting={busyAction === 'import-chat'}
                  onClearAllChats={() => void handleClearAllConversations()}
                />
              )}
            </HStack>
          </LayoutContent>
        }
      />
    </AppShell>
  );
}

type CommandStatusRow = {
  id: string;
  conversationId: string;
  kind: 'compact';
  status: 'pending' | 'compacting' | 'completed' | 'failed' | 'aborted';
  instructions: string;
  message: string;
  createdAt: string;
  completedAt?: string;
};

function SettingsPanel({
  section,
  onSectionChange,
  onClose,
  runtime,
  runtimeTone,
  runtimeLogs,
  isLogVisible,
  modelsMaxInput,
  sleepIdleInput,
  onModelsMaxInputChange,
  onSleepIdleInputChange,
  onInstall,
  onStart,
  onStop,
  onRefresh,
  onToggleLogs,
  onRefreshLogs,
  onSaveRuntimeSettings,
  models,
  activeModelId,
  routerModelsByConfiguredId,
  busyAction,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onReloadRouterModels,
  modelAliasDrafts,
  modelParamRows,
  onModelAliasChange,
  onModelParamRowsChange,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
  globalParamRows,
  onGlobalParamRowsChange,
  onSaveGlobalParams,
  searchQuery,
  searchResults,
  isSearching,
  onSearchQueryChange,
  onSearch,
  onUseHuggingFaceModel,
  conversations,
  onImportConversation,
  isImporting,
  onClearAllChats,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  runtime: RuntimeStatus | null;
  runtimeTone: 'green' | 'yellow' | 'blue';
  runtimeLogs: string;
  isLogVisible: boolean;
  modelsMaxInput: string;
  sleepIdleInput: string;
  onModelsMaxInputChange: (value: string) => void;
  onSleepIdleInputChange: (value: string) => void;
  onInstall: () => void | Promise<void>;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onToggleLogs: () => void | Promise<void>;
  onRefreshLogs: () => void | Promise<void>;
  onSaveRuntimeSettings: () => void | Promise<void>;
  models: ConfiguredModel[];
  activeModelId: string | null;
  routerModelsByConfiguredId: Map<string, LlamaRouterModel>;
  busyAction: string | null;
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onReloadRouterModels: () => void | Promise<void>;
  modelAliasDrafts: Record<string, string>;
  modelParamRows: Record<string, ParamRow[]>;
  onModelAliasChange: (modelId: string, value: string) => void;
  onModelParamRowsChange: (modelId: string, rows: ParamRow[]) => void;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
  globalParamRows: ParamRow[];
  onGlobalParamRowsChange: (rows: ParamRow[]) => void;
  onSaveGlobalParams: () => void | Promise<void>;
  searchQuery: string;
  searchResults: HuggingFaceModelResult[];
  isSearching: boolean;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void | Promise<void>;
  onUseHuggingFaceModel: (repoId: string, quant: string) => void | Promise<void>;
  conversations: ConversationListItem[];
  onImportConversation: () => void;
  isImporting: boolean;
  onClearAllChats: () => void | Promise<void>;
}) {
  return (
    <VStack gap={4} className="nelle-search-panel nelle-panel-content nelle-scroll">
      <HStack gap={2} vAlign="center">
        <Icon icon={Cog6ToothIcon} size="sm" color="secondary" />
        <StackItem size="fill">
          <Heading level={3}>Settings</Heading>
        </StackItem>
        <IconButton
          label="Close settings"
          tooltip="Close settings"
          size="sm"
          variant="ghost"
          icon={<Icon icon={XMarkIcon} size="sm" />}
          onClick={onClose}
        />
      </HStack>
      <HStack gap={1} wrap="wrap">
        {(['runtime', 'models', 'global', 'chats'] as SettingsSection[]).map(item => (
          <Button
            key={item}
            label={settingsSectionLabel(item)}
            size="sm"
            variant={section === item ? 'primary' : 'ghost'}
            onClick={() => onSectionChange(item)}
          />
        ))}
      </HStack>

      {section === 'runtime' && (
        <RuntimeSettingsSection
          runtime={runtime}
          runtimeTone={runtimeTone}
          runtimeLogs={runtimeLogs}
          isLogVisible={isLogVisible}
          modelsMaxInput={modelsMaxInput}
          sleepIdleInput={sleepIdleInput}
          busyAction={busyAction}
          onModelsMaxInputChange={onModelsMaxInputChange}
          onSleepIdleInputChange={onSleepIdleInputChange}
          onInstall={onInstall}
          onStart={onStart}
          onStop={onStop}
          onRefresh={onRefresh}
          onToggleLogs={onToggleLogs}
          onRefreshLogs={onRefreshLogs}
          onSaveRuntimeSettings={onSaveRuntimeSettings}
        />
      )}
      {section === 'models' && (
        <ModelSettingsSection
          models={models}
          activeModelId={activeModelId}
          runtime={runtime}
          routerModelsByConfiguredId={routerModelsByConfiguredId}
          busyAction={busyAction}
          modelAliasDrafts={modelAliasDrafts}
          modelParamRows={modelParamRows}
          searchQuery={searchQuery}
          searchResults={searchResults}
          isSearching={isSearching}
          onActivateModel={onActivateModel}
          onLoadModel={onLoadModel}
          onUnloadModel={onUnloadModel}
          onReloadRouterModels={onReloadRouterModels}
          onModelAliasChange={onModelAliasChange}
          onModelParamRowsChange={onModelParamRowsChange}
          onSaveModel={onSaveModel}
          onDuplicateModel={onDuplicateModel}
          onDeleteModel={onDeleteModel}
          onSearchQueryChange={onSearchQueryChange}
          onSearch={onSearch}
          onUseHuggingFaceModel={onUseHuggingFaceModel}
        />
      )}
      {section === 'global' && (
        <Card padding={3}>
          <VStack gap={3}>
            <Heading level={3}>Global llama.cpp Params</Heading>
            <KeyValueEditor rows={globalParamRows} onChange={onGlobalParamRowsChange} />
            <Button
              label="Save global params"
              size="sm"
              variant="primary"
              isLoading={busyAction === 'global-params'}
              onClick={onSaveGlobalParams}
            />
          </VStack>
        </Card>
      )}
      {section === 'chats' && (
        <Card padding={3}>
          <VStack gap={3}>
            <Heading level={3}>Chats</Heading>
            <Text type="supporting" color="secondary">
              {conversations.length.toLocaleString()} conversations stored locally.
            </Text>
            <HStack gap={2} wrap="wrap">
              <Button
                label="Import archive"
                size="sm"
                variant="secondary"
                icon={<Icon icon={ArrowUpTrayIcon} size="sm" />}
                isLoading={isImporting}
                onClick={onImportConversation}
              />
              <Button
                label="Clear all chats"
                size="sm"
                variant="secondary"
                icon={<Icon icon={TrashIcon} size="sm" />}
                isLoading={busyAction === 'clear-all-chats'}
                onClick={onClearAllChats}
              />
            </HStack>
          </VStack>
        </Card>
      )}
    </VStack>
  );
}

function RuntimeSettingsSection({
  runtime,
  runtimeTone,
  runtimeLogs,
  isLogVisible,
  modelsMaxInput,
  sleepIdleInput,
  busyAction,
  onModelsMaxInputChange,
  onSleepIdleInputChange,
  onInstall,
  onStart,
  onStop,
  onRefresh,
  onToggleLogs,
  onRefreshLogs,
  onSaveRuntimeSettings,
}: {
  runtime: RuntimeStatus | null;
  runtimeTone: 'green' | 'yellow' | 'blue';
  runtimeLogs: string;
  isLogVisible: boolean;
  modelsMaxInput: string;
  sleepIdleInput: string;
  busyAction: string | null;
  onModelsMaxInputChange: (value: string) => void;
  onSleepIdleInputChange: (value: string) => void;
  onInstall: () => void | Promise<void>;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
  onToggleLogs: () => void | Promise<void>;
  onRefreshLogs: () => void | Promise<void>;
  onSaveRuntimeSettings: () => void | Promise<void>;
}) {
  return (
    <Card padding={3}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Icon icon={CpuChipIcon} size="sm" color="secondary" />
          <Heading level={3}>llama.cpp</Heading>
        </HStack>
        <Token
          label={
            runtime?.running
              ? `Running on ${runtime.host}:${runtime.port}`
              : runtime?.installed
                ? 'Installed, stopped'
                : 'Not installed'
          }
          color={runtimeTone}
        />
        <Text type="supporting" color="secondary" className="nelle-code">
          {runtime?.binaryPath ?? 'No llama-server binary detected'}
        </Text>
        <Text type="supporting" color="secondary" className="nelle-code">
          {runtime?.logPath ?? 'llama-server log path unavailable'}
        </Text>
        <HStack gap={2} wrap="wrap">
          <Button
            label={runtime?.installed ? 'Update' : 'Install'}
            size="sm"
            variant="secondary"
            icon={<Icon icon={ArrowDownTrayIcon} size="sm" />}
            isLoading={busyAction === 'install'}
            onClick={onInstall}
          />
          <Button
            label="Start"
            size="sm"
            variant="primary"
            icon={<Icon icon={PlayIcon} size="sm" />}
            isDisabled={!runtime?.installed || runtime.running}
            isLoading={busyAction === 'start'}
            onClick={onStart}
          />
          <Button
            label="Stop"
            size="sm"
            variant="secondary"
            icon={<Icon icon={StopIcon} size="sm" />}
            isDisabled={!runtime?.running}
            isLoading={busyAction === 'stop'}
            onClick={onStop}
          />
          <Button
            label="Refresh"
            size="sm"
            variant="ghost"
            icon={<Icon icon={ArrowPathIcon} size="sm" />}
            onClick={onRefresh}
          />
          <Button
            label={isLogVisible ? 'Hide logs' : 'Show logs'}
            size="sm"
            variant="ghost"
            isLoading={busyAction === 'runtime-logs'}
            onClick={onToggleLogs}
          />
          {isLogVisible && (
            <Button
              label="Refresh logs"
              size="sm"
              variant="ghost"
              isLoading={busyAction === 'runtime-logs'}
              onClick={onRefreshLogs}
            />
          )}
        </HStack>
        {isLogVisible && (
          <CodeBlock
            code={runtimeLogs || 'No llama-server log output yet.'}
            language="text"
            width="100%"
            maxHeight="calc(var(--spacing-10) * 8)"
            isWrapped
          />
        )}
        <VStack gap={2}>
          <TextInput
            label="Max loaded models"
            value={modelsMaxInput}
            onChange={onModelsMaxInputChange}
            description="Default is 1. Requires a llama.cpp restart."
          />
          <TextInput
            label="Sleep idle seconds"
            value={sleepIdleInput}
            onChange={onSleepIdleInputChange}
            description="Default is 90. Requires a llama.cpp restart."
          />
        </VStack>
        <Button
          label="Save runtime settings"
          size="sm"
          variant="secondary"
          isLoading={busyAction === 'runtime-settings'}
          onClick={onSaveRuntimeSettings}
        />
      </VStack>
    </Card>
  );
}

function ModelSettingsSection({
  models,
  activeModelId,
  runtime,
  routerModelsByConfiguredId,
  busyAction,
  modelAliasDrafts,
  modelParamRows,
  searchQuery,
  searchResults,
  isSearching,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onReloadRouterModels,
  onModelAliasChange,
  onModelParamRowsChange,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
  onSearchQueryChange,
  onSearch,
  onUseHuggingFaceModel,
}: {
  models: ConfiguredModel[];
  activeModelId: string | null;
  runtime: RuntimeStatus | null;
  routerModelsByConfiguredId: Map<string, LlamaRouterModel>;
  busyAction: string | null;
  modelAliasDrafts: Record<string, string>;
  modelParamRows: Record<string, ParamRow[]>;
  searchQuery: string;
  searchResults: HuggingFaceModelResult[];
  isSearching: boolean;
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onReloadRouterModels: () => void | Promise<void>;
  onModelAliasChange: (modelId: string, value: string) => void;
  onModelParamRowsChange: (modelId: string, rows: ParamRow[]) => void;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void | Promise<void>;
  onUseHuggingFaceModel: (repoId: string, quant: string) => void | Promise<void>;
}) {
  return (
    <VStack gap={3}>
      <Card padding={3}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <StackItem size="fill">
              <Heading level={3}>Configured Models</Heading>
            </StackItem>
            <Button
              label="Reload"
              size="sm"
              variant="ghost"
              icon={<Icon icon={ArrowPathIcon} size="sm" />}
              isDisabled={!runtime?.running}
              isLoading={busyAction === 'router-reload'}
              onClick={onReloadRouterModels}
            />
          </HStack>
          {models.length === 0 && (
            <Text type="supporting" color="secondary">
              Search Hugging Face and choose a GGUF quant to create the first model.
            </Text>
          )}
          {models.map(model => (
            <ModelSettingsRow
              key={model.id}
              model={model}
              activeModelId={activeModelId}
              runtime={runtime}
              routerModel={routerModelsByConfiguredId.get(model.id)}
              busyAction={busyAction}
              aliasDraft={modelAliasDrafts[model.id] ?? model.name}
              paramRows={modelParamRows[model.id] ?? []}
              onActivateModel={onActivateModel}
              onLoadModel={onLoadModel}
              onUnloadModel={onUnloadModel}
              onAliasChange={value => onModelAliasChange(model.id, value)}
              onParamRowsChange={rows => onModelParamRowsChange(model.id, rows)}
              onSaveModel={onSaveModel}
              onDuplicateModel={onDuplicateModel}
              onDeleteModel={onDeleteModel}
            />
          ))}
        </VStack>
      </Card>

      <Card padding={3}>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <Icon icon={MagnifyingGlassIcon} size="sm" color="secondary" />
            <Heading level={3}>Hugging Face GGUF Search</Heading>
          </HStack>
          <TextInput
            label="Search query"
            value={searchQuery}
            onChange={onSearchQueryChange}
            placeholder="qwen coder gguf"
          />
          <Button
            label="Search GGUF models"
            variant="primary"
            icon={<Icon icon={MagnifyingGlassIcon} size="sm" />}
            isLoading={isSearching}
            onClick={onSearch}
          />
          <VStack gap={3}>
            {searchResults.map(result => (
              <VStack key={result.id} gap={2} className="nelle-model-result">
                <VStack gap={0}>
                  <Text type="label" weight="semibold">
                    {result.id}
                  </Text>
                  <Text type="supporting" color="secondary">
                    {result.downloads?.toLocaleString() ?? '0'} downloads
                  </Text>
                </VStack>
                {result.quants.map(quant => (
                  <HStack key={quant.quant} gap={2} vAlign="center">
                    <StackItem size="fill" className="nelle-tight">
                      <VStack gap={0}>
                        <Text type="supporting" className="nelle-code">
                          {quant.quant}
                        </Text>
                        <Text type="supporting" color="secondary">
                          {formatBytes(quant.size)}
                          {quant.files.length > 1 ? ` across ${quant.files.length} files` : ''}
                        </Text>
                      </VStack>
                    </StackItem>
                    <Button
                      label="Use"
                      size="sm"
                      variant="secondary"
                      isLoading={busyAction === `use:${result.id}:${quant.quant}`}
                      onClick={() => onUseHuggingFaceModel(result.id, quant.quant)}
                    />
                  </HStack>
                ))}
              </VStack>
            ))}
          </VStack>
        </VStack>
      </Card>
    </VStack>
  );
}

function ModelSettingsRow({
  model,
  activeModelId,
  runtime,
  routerModel,
  busyAction,
  aliasDraft,
  paramRows,
  onActivateModel,
  onLoadModel,
  onUnloadModel,
  onAliasChange,
  onParamRowsChange,
  onSaveModel,
  onDuplicateModel,
  onDeleteModel,
}: {
  model: ConfiguredModel;
  activeModelId: string | null;
  runtime: RuntimeStatus | null;
  routerModel?: LlamaRouterModel;
  busyAction: string | null;
  aliasDraft: string;
  paramRows: ParamRow[];
  onActivateModel: (model: ConfiguredModel) => void | Promise<void>;
  onLoadModel: (model: ConfiguredModel) => void | Promise<void>;
  onUnloadModel: (model: ConfiguredModel) => void | Promise<void>;
  onAliasChange: (value: string) => void;
  onParamRowsChange: (rows: ParamRow[]) => void;
  onSaveModel: (model: ConfiguredModel) => void | Promise<void>;
  onDuplicateModel: (model: ConfiguredModel) => void | Promise<void>;
  onDeleteModel: (model: ConfiguredModel) => void | Promise<void>;
}) {
  const routerStatus = routerModel?.status ?? (runtime?.running ? 'unlisted' : 'stopped');
  const isLoaded = routerStatus === 'loaded' || routerStatus === 'sleeping';
  const isLoading = routerStatus === 'loading';

  return (
    <VStack gap={2} className="nelle-model-settings-row">
      <HStack gap={2} vAlign="center">
        <StackItem size="fill">
          <TextInput label="Alias" value={aliasDraft} onChange={onAliasChange} />
        </StackItem>
        <Token label={formatRouterStatus(routerStatus)} color={routerStatusColor(routerStatus)} />
      </HStack>
      <Text type="supporting" color="secondary" className="nelle-code">
        {model.hfRef ?? model.presetName}
      </Text>
      {routerModel && (
        <Text type="supporting" color="secondary" className="nelle-code">
          router id: {routerModel.routerModelId ?? routerModel.sectionId}
        </Text>
      )}
      <KeyValueEditor rows={paramRows} onChange={onParamRowsChange} />
      <HStack gap={1} wrap="wrap">
        <Button
          label={model.id === activeModelId ? 'Selected' : 'Select'}
          size="sm"
          variant={model.id === activeModelId ? 'primary' : 'secondary'}
          isLoading={busyAction === 'activate'}
          onClick={() => onActivateModel(model)}
        />
        <Button
          label="Load"
          size="sm"
          variant="secondary"
          isDisabled={!runtime?.running || isLoaded || isLoading}
          isLoading={busyAction === `load:${model.id}`}
          onClick={() => onLoadModel(model)}
        />
        <Button
          label="Unload"
          size="sm"
          variant="ghost"
          isDisabled={!runtime?.running || !isLoaded}
          isLoading={busyAction === `unload:${model.id}`}
          onClick={() => onUnloadModel(model)}
        />
        <Button
          label="Save"
          size="sm"
          variant="secondary"
          isLoading={busyAction === `model-save:${model.id}`}
          onClick={() => onSaveModel(model)}
        />
        <IconButton
          label="Duplicate model"
          tooltip="Duplicate model"
          size="sm"
          variant="ghost"
          icon={<Icon icon={DocumentDuplicateIcon} size="sm" />}
          isLoading={busyAction === `model-duplicate:${model.id}`}
          onClick={() => onDuplicateModel(model)}
        />
        <IconButton
          label="Remove model"
          tooltip="Remove model"
          size="sm"
          variant="ghost"
          icon={<Icon icon={TrashIcon} size="sm" />}
          isLoading={busyAction === `model-delete:${model.id}`}
          onClick={() => onDeleteModel(model)}
        />
      </HStack>
    </VStack>
  );
}

function KeyValueEditor({
  rows,
  onChange,
}: {
  rows: ParamRow[];
  onChange: (rows: ParamRow[]) => void;
}) {
  const visibleRows = rows.length > 0 ? rows : [{id: createParamRowId(), key: '', value: ''}];
  return (
    <VStack gap={2}>
      {visibleRows.map(row => (
        <HStack key={row.id} gap={1} vAlign="end">
          <StackItem size="fill">
            <TextInput
              label="Key"
              value={row.key}
              onChange={value => onChange(updateParamRows(visibleRows, row.id, {key: value}))}
            />
          </StackItem>
          <StackItem size="fill">
            <TextInput
              label="Value"
              value={row.value}
              onChange={value => onChange(updateParamRows(visibleRows, row.id, {value}))}
            />
          </StackItem>
          <IconButton
            label="Remove parameter"
            tooltip="Remove parameter"
            size="sm"
            variant="ghost"
            icon={<Icon icon={TrashIcon} size="sm" />}
            onClick={() => onChange(visibleRows.filter(item => item.id !== row.id))}
          />
        </HStack>
      ))}
      <Button
        label="Add parameter"
        size="sm"
        variant="ghost"
        icon={<Icon icon={PlusIcon} size="sm" />}
        onClick={() => onChange([...visibleRows, {id: createParamRowId(), key: '', value: ''}])}
      />
    </VStack>
  );
}

function settingsSectionLabel(section: SettingsSection): string {
  if (section === 'runtime') {
    return 'Runtime';
  }
  if (section === 'models') {
    return 'Models';
  }
  if (section === 'global') {
    return 'Global Params';
  }
  return 'Chats';
}

function ContextWindowUsage({context}: {context: ConversationContextUsage}) {
  const totalTokens = positiveTokenCount(context.totalTokens);
  if (totalTokens == null) {
    return null;
  }
  const usedTokens = positiveTokenCount(context.usedTokens) ?? 0;
  const progressTokens = Math.min(usedTokens, totalTokens);
  const tooltip = `Context: ${formatInteger(usedTokens)} / ${formatInteger(totalTokens)} tokens`;

  return (
    <Tooltip content={tooltip}>
      <HStack
        vAlign="center"
        className="nelle-context-progress"
        data-testid="composer-context-progress"
      >
        <ProgressBar
          label="Context window usage"
          value={progressTokens}
          max={totalTokens}
          isLabelHidden
          variant={contextProgressVariant(context)}
        />
      </HStack>
    </Tooltip>
  );
}

function AttachmentDrawer({
  attachments,
  onRemove,
}: {
  attachments: DraftAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <ChatComposerDrawer
      count={attachments.length}
      label="Attachments"
      data-testid="attachment-drawer"
    >
      <HStack gap={1} vAlign="center" wrap="wrap">
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
              onRemove={() => onRemove(attachment.id)}
            />
          </Tooltip>
        ))}
      </HStack>
    </ChatComposerDrawer>
  );
}

function applyConversationSnapshot(
  snapshot: ConversationSnapshot,
  setMessages: (messages: ApiChatMessage[]) => void,
  setContextUsage: (context: ConversationContextUsage) => void,
) {
  setMessages(messagesFromSnapshot(snapshot));
  setContextUsage(snapshot.context ?? {});
}

function mergeContextTotals(
  context: ConversationContextUsage,
  totalTokens?: number,
): ConversationContextUsage {
  return {
    ...context,
    totalTokens: positiveTokenCount(totalTokens) ?? context.totalTokens,
  };
}

function contextUsageFromPerformance(
  performance: ChatPerformance,
  totalTokens?: number,
): ConversationContextUsage | null {
  const promptTokens =
    positiveTokenCount(performance.prompt?.totalTokens) ??
    positiveTokenCount(performance.prompt?.tokens);
  if (promptTokens == null) {
    return null;
  }
  const generationTokens = positiveTokenCount(getGenerationMetric(performance)?.tokens) ?? 0;
  return {
    usedTokens: promptTokens + generationTokens,
    totalTokens: positiveTokenCount(totalTokens),
    source: performance.source === 'llamacpp-timings' ? 'timings' : 'prompt_progress',
    updatedAt: new Date().toISOString(),
  };
}

function mergeLiveContextUsage(
  current: ConversationContextUsage,
  next: ConversationContextUsage,
): ConversationContextUsage {
  return {
    ...current,
    ...next,
    totalTokens: next.totalTokens ?? current.totalTokens,
  };
}

function getContextOverflowMessage(context: ConversationContextUsage): string | null {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 1) {
    return null;
  }
  return 'The selected model context window is full.';
}

function getContextWarningMessage(context: ConversationContextUsage): string | null {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 0.8 || ratio >= 1) {
    return null;
  }
  return `Context is ${Math.round(ratio * 100)}% full.`;
}

function contextProgressVariant(context: ConversationContextUsage): 'accent' | 'warning' | 'error' {
  const ratio = contextUsageRatio(context);
  if (ratio == null || ratio < 0.8) {
    return 'accent';
  }
  return ratio >= 1 ? 'error' : 'warning';
}

function contextUsageRatio(context: ConversationContextUsage): number | null {
  const usedTokens = positiveTokenCount(context.usedTokens);
  const totalTokens = positiveTokenCount(context.totalTokens);
  if (usedTokens == null || totalTokens == null) {
    return null;
  }
  return usedTokens / totalTokens;
}

function positiveTokenCount(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function formatInteger(value: number): string {
  return value.toLocaleString();
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

type ConversationListRow =
  | {
      key: string;
      type: 'section';
      label: string;
      count: number;
    }
  | {
      key: string;
      type: 'conversation';
      conversation: ConversationListItem;
    };

function CollapsedSidebar({
  onExpand,
  onOpenSettings,
  onNewConversation,
  isNewConversationBusy,
}: {
  onExpand: () => void;
  onOpenSettings: () => void;
  onNewConversation: () => void | Promise<void>;
  isNewConversationBusy: boolean;
}) {
  return (
    <VStack gap={2} hAlign="center" className="nelle-collapsed-sidebar-content">
      <IconButton
        label="Expand sidebar"
        tooltip="Expand sidebar"
        size="sm"
        variant="ghost"
        icon={<Icon icon={ChevronRightIcon} size="sm" />}
        onClick={onExpand}
      />
      <IconButton
        label="New chat"
        tooltip="New chat"
        size="sm"
        variant="primary"
        icon={<Icon icon={PlusIcon} size="sm" />}
        isLoading={isNewConversationBusy}
        onClick={() => void onNewConversation()}
      />
      <IconButton
        label="Settings"
        tooltip="Settings"
        size="sm"
        variant="ghost"
        icon={<Icon icon={Cog6ToothIcon} size="sm" />}
        onClick={onOpenSettings}
      />
    </VStack>
  );
}

function ConversationVirtualList({
  conversations,
  query,
  activeConversationId,
  onSelect,
  onTogglePin,
  onRename,
  onReset,
  onExport,
  onClone,
  onDelete,
}: {
  conversations: ConversationListItem[];
  query: string;
  activeConversationId: string;
  onSelect: (conversationId: string) => void | Promise<void>;
  onTogglePin: (conversation: ConversationListItem) => void | Promise<void>;
  onRename: (conversation: ConversationListItem) => void | Promise<void>;
  onReset: (conversationId: string) => void | Promise<void>;
  onExport: (conversation: ConversationListItem) => void | Promise<void>;
  onClone: (conversation: ConversationListItem) => void | Promise<void>;
  onDelete: (conversation: ConversationListItem) => void | Promise<void>;
}) {
  const rows = useMemo(() => buildConversationRows(conversations, query), [conversations, query]);
  const scrollRef = useRef<HTMLElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: index => (rows[index]?.type === 'section' ? 30 : 48),
    getItemKey: index => rows[index]?.key ?? index,
    overscan: 10,
  });

  if (rows.length === 0) {
    return (
      <VStack data-testid="conversation-list" className="nelle-conversation-list-empty">
        <Text type="supporting" color="secondary">
          No conversations match this search.
        </Text>
      </VStack>
    );
  }

  return (
    <VStack
      ref={scrollRef}
      data-testid="conversation-list"
      gap={0}
      className="nelle-conversation-list"
    >
      <VStack
        gap={0}
        className="nelle-conversation-virtual-space"
        style={{height: `${virtualizer.getTotalSize()}px`}}
      >
        {virtualizer.getVirtualItems().map(virtualRow => {
          const row = rows[virtualRow.index];
          if (!row) {
            return null;
          }
          return (
            <VStack
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              gap={0}
              className="nelle-conversation-virtual-row"
              style={{transform: `translateY(${virtualRow.start}px)`}}
            >
              {row.type === 'section' ? (
                <ConversationSectionRow row={row} />
              ) : (
                <ConversationRow
                  conversation={row.conversation}
                  isActive={row.conversation.id === activeConversationId}
                  onSelect={onSelect}
                  onTogglePin={onTogglePin}
                  onRename={onRename}
                  onReset={onReset}
                  onExport={onExport}
                  onClone={onClone}
                  onDelete={onDelete}
                />
              )}
            </VStack>
          );
        })}
      </VStack>
    </VStack>
  );
}

function ConversationSectionRow({row}: {row: Extract<ConversationListRow, {type: 'section'}>}) {
  return (
    <HStack
      gap={2}
      vAlign="center"
      className="nelle-conversation-section-row"
      data-testid={`conversation-section-${row.label.toLowerCase()}`}
    >
      <Text type="supporting" color="secondary" weight="semibold">
        {row.label}
      </Text>
      <Token size="sm" color="gray" label={String(row.count)} />
    </HStack>
  );
}

function ConversationRow({
  conversation,
  isActive,
  onSelect,
  onTogglePin,
  onRename,
  onReset,
  onExport,
  onClone,
  onDelete,
}: {
  conversation: ConversationListItem;
  isActive: boolean;
  onSelect: (conversationId: string) => void | Promise<void>;
  onTogglePin: (conversation: ConversationListItem) => void | Promise<void>;
  onRename: (conversation: ConversationListItem) => void | Promise<void>;
  onReset: (conversationId: string) => void | Promise<void>;
  onExport: (conversation: ConversationListItem) => void | Promise<void>;
  onClone: (conversation: ConversationListItem) => void | Promise<void>;
  onDelete: (conversation: ConversationListItem) => void | Promise<void>;
}) {
  return (
    <HStack
      gap={1}
      vAlign="center"
      className="nelle-conversation-row"
      data-testid={`conversation-row-${conversation.id}`}
    >
      <StackItem size="fill" className="nelle-tight">
        <Button
          label={conversation.title}
          size="sm"
          variant={isActive ? 'primary' : 'ghost'}
          onClick={() => void onSelect(conversation.id)}
        />
      </StackItem>
      {conversation.status !== 'ready' && (
        <ConversationStatusIndicator status={conversation.status} />
      )}
      {conversation.pinned && <Token size="sm" label="pinned" color="blue" />}
      <DropdownMenu
        button={{
          label: `Actions for ${conversation.title}`,
          variant: 'ghost',
          size: 'sm',
          children: <Icon icon={EllipsisHorizontalIcon} size="sm" />,
        }}
        items={[
          {
            label: conversation.pinned ? 'Unpin' : 'Pin',
            onClick: () => void onTogglePin(conversation),
          },
          {
            label: 'Rename',
            onClick: () => void onRename(conversation),
          },
          {
            label: 'Reset',
            onClick: () => void onReset(conversation.id),
          },
          {
            label: 'Export',
            onClick: () => void onExport(conversation),
          },
          {
            label: 'Duplicate',
            onClick: () => void onClone(conversation),
          },
          {
            label: 'Delete',
            onClick: () => void onDelete(conversation),
          },
        ]}
      />
    </HStack>
  );
}

function ConversationStatusIndicator({status}: {status: ConversationListItem['status']}) {
  const label = status.replace(/_/g, ' ');
  const variant = status === 'unavailable' ? 'error' : status === 'running' ? 'accent' : 'warning';
  return (
    <Tooltip content={`Conversation ${label}`}>
      <HStack gap={0.5} vAlign="center" className="nelle-conversation-status">
        <StatusDot
          label={`Conversation ${label}`}
          variant={variant}
          isPulsing={status === 'running' || status === 'compacting' || status === 'aborting'}
        />
        <Text type="supporting" color="secondary">
          {label}
        </Text>
      </HStack>
    </Tooltip>
  );
}

function buildConversationRows(
  conversations: ConversationListItem[],
  query: string,
): ConversationListRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? conversations.filter(conversation =>
        conversation.title.toLowerCase().includes(normalizedQuery),
      )
    : conversations;
  const pinned = filtered.filter(conversation => conversation.pinned);
  const unpinned = filtered.filter(conversation => !conversation.pinned);
  const rows: ConversationListRow[] = [];
  if (pinned.length > 0) {
    rows.push({key: 'section:pinned', type: 'section', label: 'Pinned', count: pinned.length});
    for (const conversation of pinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  if (unpinned.length > 0) {
    rows.push({
      key: normalizedQuery ? 'section:results' : 'section:recent',
      type: 'section',
      label: normalizedQuery ? 'Results' : 'Recent',
      count: unpinned.length,
    });
    for (const conversation of unpinned) {
      rows.push({key: `conversation:${conversation.id}`, type: 'conversation', conversation});
    }
  }
  return rows;
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
  if (message.role === 'system') {
    return <ChatSystemMessage>{message.content}</ChatSystemMessage>;
  }

  return (
    <ChatMessage
      sender={message.role === 'assistant' ? 'assistant' : 'user'}
      avatar={message.role === 'assistant' ? <Avatar name="Nelle" size="small" /> : undefined}
    >
      {message.toolCalls && message.toolCalls.length > 0 && <ToolCalls calls={message.toolCalls} />}
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} />
      )}
      <ChatMessageBubble
        variant={message.role === 'assistant' ? 'ghost' : undefined}
        metadata={
          <ChatMessageMetadata
            timestamp={<Timestamp value={message.createdAt} format="time" />}
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
          <Markdown density="compact">{message.content || '...'}</Markdown>
        ) : (
          message.content
        )}
      </ChatMessageBubble>
    </ChatMessage>
  );
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

  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
      {canForkFromMessage && (
        <IconButton
          label="Fork from here"
          tooltip="Fork from here"
          size="sm"
          variant="ghost"
          icon={<Icon icon={ChatBubbleLeftRightIcon} size="sm" />}
          isDisabled={isActionDisabled}
          onClick={() => void onFork(message)}
        />
      )}
      {message.role === 'assistant' && (
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
      )}
      {hasPerformance && <PerformanceStatistics performance={message.performance!} />}
      {message.role === 'assistant' && (
        <>
          {message.variantLabel && <Token size="sm" color="blue" label={message.variantLabel} />}
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
        </>
      )}
    </HStack>
  );
}

type StatisticsView = 'reading' | 'generation';

function PerformanceStatistics({performance}: {performance: ChatPerformance}) {
  const promptMetric = performance.prompt;
  const generationMetric = getGenerationMetric(performance);
  const hasPrompt = hasPerformanceMetric(promptMetric);
  const hasGeneration = hasPerformanceMetric(generationMetric);
  const [view, setView] = useState<StatisticsView>(() =>
    hasGeneration && !hasPrompt ? 'generation' : 'reading',
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

function messagesFromSnapshot(snapshot: ConversationSnapshot): ApiChatMessage[] {
  const attachmentsByEntry = new Map<string, AttachmentMetadata[]>();
  for (const attachment of snapshot.attachments) {
    if (!attachment.piEntryId) {
      continue;
    }
    const list = attachmentsByEntry.get(attachment.piEntryId) ?? [];
    list.push(attachment);
    attachmentsByEntry.set(attachment.piEntryId, list);
  }
  const messages = snapshot.entries
    .filter(entry => entry.entryType === 'message' && entry.role != null)
    .map(entry => ({
      id: entry.piEntryId,
      role: entry.role!,
      content: entry.textPreview ?? '',
      createdAt: entry.createdAt,
      parentPiEntryId: entry.parentPiEntryId,
      modelId: entry.modelId,
      modelRuntimeId: entry.modelRuntimeId,
      modelAliasSnapshot: entry.modelAliasSnapshot,
      regeneratesPiEntryId: entry.regeneratesPiEntryId,
      displayGroupId: entry.displayGroupId,
      performance: entry.performance as ChatPerformance | undefined,
      toolCalls: entry.toolCalls as ApiChatMessage['toolCalls'],
      attachments: attachmentsByEntry.get(entry.piEntryId),
    }));
  const replayedUserIds = new Set(
    messages
      .filter(message => message.role === 'assistant' && message.regeneratesPiEntryId)
      .map(message => message.parentPiEntryId)
      .filter(id => id != null),
  );
  const visibleMessages = messages.filter(
    message => !(message.role === 'user' && replayedUserIds.has(message.id)),
  );
  const assistantGroups = new Map<string, ApiChatMessage[]>();
  for (const message of visibleMessages) {
    if (message.role !== 'assistant') {
      continue;
    }
    const groupId = message.displayGroupId ?? message.regeneratesPiEntryId ?? message.id;
    const group = assistantGroups.get(groupId) ?? [];
    group.push(message);
    assistantGroups.set(groupId, group);
  }
  for (const group of assistantGroups.values()) {
    if (group.length < 2) {
      continue;
    }
    group
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .forEach((message, index) => {
        message.variantLabel = `variant ${index + 1}/${group.length}`;
      });
  }
  return visibleMessages;
}

function ToolCalls({calls}: {calls: NonNullable<ApiChatMessage['toolCalls']>}) {
  return (
    <ChatToolCalls
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

function mergeChatPerformance(
  current: ChatPerformance | undefined,
  next: ChatPerformance,
): ChatPerformance {
  if (!current) {
    return next;
  }
  const source =
    current.source === 'llamacpp-timings' || next.source === 'llamacpp-timings'
      ? 'llamacpp-timings'
      : 'llamacpp-slots';
  const generation = mergeMetric(current.generation, next.generation, next.source);
  return {
    source,
    prompt: mergeMetric(current.prompt, next.prompt, next.source),
    generation,
    tokensPerSecond: generation?.tokensPerSecond ?? next.tokensPerSecond ?? current.tokensPerSecond,
    generatedTokens: generation?.tokens ?? next.generatedTokens ?? current.generatedTokens,
  };
}

function mergeMetric(
  current: ChatPerformanceMetric | undefined,
  next: ChatPerformanceMetric | undefined,
  nextSource: ChatPerformance['source'],
): ChatPerformanceMetric | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  if (nextSource === 'llamacpp-slots') {
    return current;
  }
  return next;
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

function parseCompactCommand(value: string): string | null {
  if (value === '/compact') {
    return '';
  }
  if (value.startsWith('/compact ')) {
    return value.slice('/compact '.length).trim();
  }
  return null;
}

function normalizeComposerValue(value: string): string {
  return value.replace(/\u00a0/g, ' ').trim();
}

function getUnsupportedSlashCommandMessage(value: string): string | null {
  const command = parseSlashCommandName(value);
  if (!command || command === '/compact') {
    return null;
  }
  const guidance = SLASH_COMMAND_GUIDANCE[command];
  if (guidance) {
    return `${command} is handled by Nelle UI. ${guidance}`;
  }
  return `${command} is not supported in Nelle chat. Use /compact for manual context compaction.`;
}

function parseSlashCommandName(value: string): string | null {
  const match = value.trim().match(/^\/[^\s]+/);
  return match?.[0]?.toLowerCase() ?? null;
}

const SLASH_COMMAND_GUIDANCE: Record<string, string> = {
  '/new': 'Use the New chat button in the conversation sidebar.',
  '/resume': 'Use the conversation sidebar and search to resume a chat.',
  '/model': 'Use the model selector in the composer or assistant footer.',
  '/scoped-models': 'Use Nelle model selectors and Settings instead.',
  '/login': 'Nelle manages the local llama.cpp provider through Settings.',
  '/logout': 'Nelle manages the local llama.cpp provider through Settings.',
  '/settings': 'Use the Settings controls in the sidebar.',
  '/fork': 'Use message and conversation menus for fork actions.',
  '/clone': 'Use the conversation menu duplicate action.',
  '/name': 'Use the conversation row rename action.',
  '/session': 'Use the conversation sidebar.',
  '/tree': 'Nelle does not expose the full Pi tree explorer in v1.',
  '/export': 'Use the conversation export action when it is available.',
  '/import': 'Use the conversation import action when it is available.',
  '/share': 'Sharing is not exposed in this local-first version yet.',
  '/copy': 'Use assistant message copy buttons.',
  '/trust': 'Host tool trust is managed by Nelle settings.',
  '/reload': 'Use the runtime and router refresh controls.',
  '/hotkeys': 'Keyboard help is not exposed in the chat composer yet.',
  '/changelog': 'Release notes are not exposed in the chat composer.',
  '/quit': 'Stop the server from the host process or runtime controls.',
};

async function prepareDraftAttachments(
  files: File[],
  input: {existing: DraftAttachment[]; canAttachImages: boolean},
): Promise<{attachments: DraftAttachment[]; warning?: string}> {
  if (input.existing.length + files.length > ATTACHMENT_LIMITS.maxFiles) {
    throw new Error(`Attach at most ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
  }
  const existingBytes = input.existing.reduce(
    (sum, attachment) => sum + (attachment.sizeBytes ?? 0),
    0,
  );
  let nextBytes = existingBytes;
  const attachments: DraftAttachment[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      throw new Error(
        `${file.name} is larger than ${formatBytes(ATTACHMENT_LIMITS.maxFileBytes)}.`,
      );
    }
    nextBytes += file.size;
    if (nextBytes > ATTACHMENT_LIMITS.maxDraftBytes) {
      throw new Error(
        `Attachments are limited to ${formatBytes(ATTACHMENT_LIMITS.maxDraftBytes)} per message.`,
      );
    }
    const result = await prepareDraftAttachment(file, input.canAttachImages);
    if (result.warning) {
      warnings.push(result.warning);
    }
    attachments.push(result.attachment);
  }
  return {attachments, warning: warnings.join(' ') || undefined};
}

async function prepareDraftAttachment(
  file: File,
  canAttachImages: boolean,
): Promise<{attachment: DraftAttachment; warning?: string}> {
  if (isImageFile(file)) {
    if (!canAttachImages) {
      throw new Error('Image attachments require a selected model with vision support.');
    }
    return {
      attachment: {
        id: crypto.randomUUID(),
        kind: 'image',
        name: file.name,
        mimeType: file.type || mimeTypeFromName(file.name) || 'image/jpeg',
        sizeBytes: file.size,
        data: await readFileAsBase64(file),
      },
    };
  }

  if (isPdfFile(file)) {
    const extracted = await extractPdfText(file);
    if (!extracted.text.trim()) {
      throw new Error(`${file.name} did not contain extractable text.`);
    }
    return {
      attachment: {
        id: crypto.randomUUID(),
        kind: 'pdf',
        name: file.name,
        mimeType: file.type || 'application/pdf',
        sizeBytes: file.size,
        text: extracted.text,
      },
      warning: extracted.truncated
        ? `${file.name} was truncated to ${ATTACHMENT_LIMITS.maxTextCharacters.toLocaleString()} characters.`
        : undefined,
    };
  }

  if (!isTextFile(file)) {
    throw new Error(`${file.name} is not a supported text, PDF, or image attachment.`);
  }

  const rawText = await file.text();
  if (isBinaryText(rawText)) {
    throw new Error(
      `${file.name} looks like a binary file. Attach text, PDF, or image files only.`,
    );
  }
  const text = rawText.slice(0, ATTACHMENT_LIMITS.maxTextCharacters);
  if (!text.trim()) {
    throw new Error(`${file.name} is empty.`);
  }
  return {
    attachment: {
      id: crypto.randomUUID(),
      kind: 'text',
      name: file.name,
      mimeType: file.type || mimeTypeFromName(file.name) || 'text/plain',
      sizeBytes: file.size,
      text,
    },
    warning:
      rawText.length > text.length
        ? `${file.name} was truncated to ${ATTACHMENT_LIMITS.maxTextCharacters.toLocaleString()} characters.`
        : undefined,
  };
}

let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  pdfJsPromise ??= import('pdfjs-dist').then(module => {
    return import('pdfjs-dist/build/pdf.worker.mjs?url').then(workerModule => {
      module.GlobalWorkerOptions.workerSrc = pdfWorkerUrlFromModule(workerModule);
      return module;
    });
  });
  return pdfJsPromise;
}

function pdfWorkerUrlFromModule(workerModule: unknown): string {
  if (typeof workerModule === 'string') {
    return workerModule;
  }
  const value = (workerModule as {default?: unknown}).default;
  if (typeof value !== 'string') {
    throw new Error('Could not resolve the PDF worker URL.');
  }
  return value;
}

async function extractPdfText(file: File): Promise<{text: string; truncated: boolean}> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({data: new Uint8Array(await file.arrayBuffer())});
  const document = await task.promise;
  const pages: string[] = [];
  let truncated = false;
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map(item => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean)
        .join(' ');
      if (pageText) {
        pages.push(pageText);
      }
      const currentText = pages.join('\n\n');
      if (currentText.length >= ATTACHMENT_LIMITS.maxTextCharacters) {
        truncated = true;
        return {
          text: currentText.slice(0, ATTACHMENT_LIMITS.maxTextCharacters),
          truncated,
        };
      }
    }
    return {text: pages.join('\n\n'), truncated};
  } finally {
    await document.cleanup();
    await task.destroy();
  }
}

async function readFileAsBase64(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result ?? '')));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('File read failed.')));
    reader.readAsDataURL(file);
  });
  return dataUrl.split(',')[1] ?? '';
}

function getDraftAttachmentError(
  attachments: DraftAttachment[],
  activeModelProps: LlamaModelProps | null,
): string | null {
  if (!attachments.some(attachment => attachment.kind === 'image')) {
    return null;
  }
  if (activeModelProps?.modalities.vision === true) {
    return null;
  }
  return 'Image attachments require a selected model with vision support.';
}

function attachmentTooltip(attachment: DraftAttachment | AttachmentMetadata): string {
  const type =
    attachment.kind === 'pdf' ? 'PDF text' : attachment.kind === 'image' ? 'Image' : 'Text file';
  return `${type} · ${formatBytes(attachment.sizeBytes ?? null)}`;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith('text/') ||
    /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|toml|ini|sql)$/i.test(file.name)
  );
}

function mimeTypeFromName(name: string): string | undefined {
  if (/\.pdf$/i.test(name)) {
    return 'application/pdf';
  }
  if (/\.png$/i.test(name)) {
    return 'image/png';
  }
  if (/\.webp$/i.test(name)) {
    return 'image/webp';
  }
  if (/\.gif$/i.test(name)) {
    return 'image/gif';
  }
  if (/\.jpe?g$/i.test(name)) {
    return 'image/jpeg';
  }
  return undefined;
}

function isBinaryText(value: string): boolean {
  return value.includes('\u0000');
}

function restoreComposerDraft(value: string, setDraft: (value: string) => void) {
  window.setTimeout(() => {
    setDraft(value);
  }, 0);
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
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

function paramsToRows(params: Record<string, string>): ParamRow[] {
  return Object.entries(params).map(([key, value]) => ({
    id: createParamRowId(),
    key,
    value,
  }));
}

function rowsToParams(rows: ParamRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.map(row => [row.key.trim(), row.value.trim()] as const).filter(([key]) => key.length > 0),
  );
}

function updateParamRows(
  rows: ParamRow[],
  id: string,
  patch: Partial<Pick<ParamRow, 'key' | 'value'>>,
): ParamRow[] {
  return rows.map(row => (row.id === id ? {...row, ...patch} : row));
}

function createParamRowId(): string {
  return `param-${Math.random().toString(36).slice(2)}`;
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
