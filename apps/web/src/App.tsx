import {useEffect, useMemo, useRef, useState} from 'react';
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
  ChatComposerInput,
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
import {TextInput} from '@astryxdesign/core/TextInput';
import {DropdownMenu} from '@astryxdesign/core/DropdownMenu';
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
  ArrowTrendingUpIcon,
  BookOpenIcon,
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentIcon,
  Cog6ToothIcon,
  ClockIcon,
  CpuChipIcon,
  DocumentTextIcon,
  EllipsisHorizontalIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PlayIcon,
  SparklesIcon,
  StopIcon,
} from '@heroicons/react/24/outline';

import {
  abortConversationCompaction,
  abortConversation,
  activateModel,
  clearConversation,
  compactConversation,
  createConversation,
  deleteConversation,
  getConversation,
  getConversations,
  getLlamaModels,
  getRuntime,
  getRuntimeLogs,
  getState,
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
  updateRuntimeSettings,
  useHuggingFaceModel,
  type ChatMessage as ApiChatMessage,
  type ChatPerformance,
  type ChatPerformanceMetric,
  type ChatStreamEvent,
  type ConfiguredModel,
  type ConversationListItem,
  type ConversationSnapshot,
  type HuggingFaceModelResult,
  type LlamaRouterModel,
  type RuntimeStatus,
} from './api';

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

export function App() {
  const showToast = useToast();
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [routerModels, setRouterModels] = useState<LlamaRouterModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('poc-default');
  const [messages, setMessages] = useState<ApiChatMessage[]>([]);
  const [conversationSearch, setConversationSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('qwen gguf');
  const [searchResults, setSearchResults] = useState<HuggingFaceModelResult[]>([]);
  const [modelsMaxInput, setModelsMaxInput] = useState('1');
  const [sleepIdleInput, setSleepIdleInput] = useState('90');
  const [isLogVisible, setIsLogVisible] = useState(false);
  const [runtimeLogs, setRuntimeLogs] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
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
          setMessages(messagesFromSnapshot(snapshot));
        }
      } catch {
        if (!isCancelled) {
          setMessages(response.state.chat);
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

  async function refreshState() {
    const response = await getState();
    setRuntime(response.runtime);
    setModelsMaxInput(String(response.runtime.modelsMax ?? response.state.runtime?.modelsMax ?? 1));
    setSleepIdleInput(
      String(response.runtime.sleepIdleSeconds ?? response.state.runtime?.sleepIdleSeconds ?? 90),
    );
    setModels(response.state.models);
    setActiveModelId(response.state.activeModelId);
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
      setMessages(messagesFromSnapshot(snapshot));
    } catch {
      setMessages(fallbackMessages);
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

  async function handleChatSubmit(value: string) {
    const prompt = value.trim();
    if (!prompt || isStreaming || isCompacting) {
      return;
    }
    const compactInstructions = parseCompactCommand(prompt);
    if (compactInstructions != null) {
      await handleCompactConversation(compactInstructions);
      return;
    }
    setIsStreaming(true);
    setNotice(null);
    const abortController = new AbortController();
    streamAbortController.current = abortController;
    try {
      await streamConversationChat(
        activeConversationId,
        prompt,
        applyChatEvent,
        abortController.signal,
      );
      setRuntime(await getRuntime());
      await refreshConversations(activeConversationId);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (streamAbortController.current === abortController) {
        streamAbortController.current = null;
      }
      setIsStreaming(false);
    }
  }

  async function handleCompactConversation(instructions: string) {
    setIsCompacting(true);
    setNotice({type: 'info', text: 'Compacting conversation context...'});
    const abortController = new AbortController();
    compactAbortController.current = abortController;
    try {
      const result = await compactConversation(
        activeConversationId,
        instructions || undefined,
        abortController.signal,
      );
      setMessages(messagesFromSnapshot(result.snapshot));
      await refreshConversations(activeConversationId);
      setNotice({type: 'success', text: 'Conversation compacted.'});
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
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
      await refreshConversations(created.id);
    });
  }

  async function handleSelectConversation(conversationId: string) {
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
      }
      await refreshConversations(activeConversationId);
    });
  }

  async function handleStopGeneration() {
    streamAbortController.current?.abort();
    await runAction('abort-chat', async () => {
      await abortConversation(activeConversationId);
      setIsStreaming(false);
      await refreshConversations(activeConversationId);
      setNotice({type: 'info', text: 'Generation stopped.'});
    });
  }

  async function handleStopCompaction() {
    compactAbortController.current?.abort();
    await runAction('abort-compaction', async () => {
      await abortConversationCompaction(activeConversationId);
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

    const currentRouterModel = findRouterModelForConfiguredModel(model, routerModels);
    if (currentRouterModel?.status === 'loaded' || currentRouterModel?.status === 'sleeping') {
      return;
    }

    await loadLlamaModel(model.id);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const nextRouterModels = await getLlamaModels();
      setRouterModels(nextRouterModels);
      const nextRouterModel = findRouterModelForConfiguredModel(model, nextRouterModels);
      if (nextRouterModel?.status === 'loaded' || nextRouterModel?.status === 'sleeping') {
        return;
      }
      if (nextRouterModel?.status === 'failed') {
        throw new Error(`${model.name} failed to load. Check the llama.cpp logs.`);
      }
      await delay(500);
    }
    throw new Error(`${model.name} did not finish loading before regeneration timed out.`);
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
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
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
      setNotice({type: 'warning', text: event.message});
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
      setNotice({type: 'error', text: event.message});
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
                          onDelete={handleDeleteConversation}
                        />
                      </VStack>
                    </Card>
                  </>
                )}

                {!isSidebarCollapsed && (
                  <>
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
                            onClick={() =>
                              runAction('install', async () => {
                                setRuntime(await installRuntime());
                              })
                            }
                          />
                          <Button
                            label="Start"
                            size="sm"
                            variant="primary"
                            icon={<Icon icon={PlayIcon} size="sm" />}
                            isDisabled={!runtime?.installed || runtime.running}
                            isLoading={busyAction === 'start'}
                            onClick={() =>
                              runAction('start', async () => {
                                setRuntime(await startRuntime());
                                await refreshState();
                              })
                            }
                          />
                          <Button
                            label="Stop"
                            size="sm"
                            variant="secondary"
                            icon={<Icon icon={StopIcon} size="sm" />}
                            isDisabled={!runtime?.running}
                            isLoading={busyAction === 'stop'}
                            onClick={() =>
                              runAction('stop', async () => {
                                setRuntime(await stopRuntime());
                                setRouterModels([]);
                              })
                            }
                          />
                          <Button
                            label="Refresh"
                            size="sm"
                            variant="ghost"
                            icon={<Icon icon={ArrowPathIcon} size="sm" />}
                            onClick={() =>
                              runAction('refresh', async () => {
                                await refreshState();
                              })
                            }
                          />
                          <Button
                            label={isLogVisible ? 'Hide logs' : 'Show logs'}
                            size="sm"
                            variant="ghost"
                            isLoading={busyAction === 'runtime-logs'}
                            onClick={handleToggleLogs}
                          />
                          {isLogVisible && (
                            <Button
                              label="Refresh logs"
                              size="sm"
                              variant="ghost"
                              isLoading={busyAction === 'runtime-logs'}
                              onClick={handleRefreshLogs}
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
                            onChange={setModelsMaxInput}
                            description="Default is 1. Requires a llama.cpp restart."
                          />
                          <TextInput
                            label="Sleep idle seconds"
                            value={sleepIdleInput}
                            onChange={setSleepIdleInput}
                            description="Default is 90. Requires a llama.cpp restart."
                          />
                        </VStack>
                        <Button
                          label="Save runtime settings"
                          size="sm"
                          variant="secondary"
                          isLoading={busyAction === 'runtime-settings'}
                          onClick={handleSaveRuntimeSettings}
                        />
                      </VStack>
                    </Card>

                    <Card padding={3}>
                      <VStack gap={3}>
                        <HStack gap={2} vAlign="center">
                          <StackItem size="fill">
                            <Heading level={3}>Configured models</Heading>
                          </StackItem>
                          <Button
                            label="Reload router models"
                            size="sm"
                            variant="ghost"
                            icon={<Icon icon={ArrowPathIcon} size="sm" />}
                            isDisabled={!runtime?.running}
                            isLoading={busyAction === 'router-reload'}
                            onClick={handleReloadRouterModels}
                          />
                        </HStack>
                        {models.length === 0 && (
                          <Text type="supporting" color="secondary">
                            Search Hugging Face and choose a GGUF quant to create the first model.
                          </Text>
                        )}
                        {models.map(model => {
                          const routerModel = routerModelsByConfiguredId.get(model.id);
                          const routerStatus =
                            routerModel?.status ?? (runtime?.running ? 'unlisted' : 'stopped');
                          const isLoaded = routerStatus === 'loaded' || routerStatus === 'sleeping';
                          const isLoading = routerStatus === 'loading';
                          return (
                            <Card key={model.id} padding={2}>
                              <VStack gap={0.5}>
                                <HStack gap={2} vAlign="center">
                                  <StackItem size="fill">
                                    <Text type="label" weight="semibold">
                                      {model.name}
                                    </Text>
                                  </StackItem>
                                  <Token
                                    label={formatRouterStatus(routerStatus)}
                                    color={routerStatusColor(routerStatus)}
                                  />
                                </HStack>
                                <Text type="supporting" color="secondary" className="nelle-code">
                                  {model.hfRef ?? model.presetName}
                                </Text>
                                {routerModel && (
                                  <Text type="supporting" color="secondary" className="nelle-code">
                                    router id: {routerModel.routerModelId ?? routerModel.sectionId}
                                  </Text>
                                )}
                                <HStack gap={1} wrap="wrap">
                                  <Button
                                    label={
                                      model.id === activeModelId
                                        ? 'Selected'
                                        : `Select ${model.name}`
                                    }
                                    size="sm"
                                    variant={model.id === activeModelId ? 'primary' : 'secondary'}
                                    isLoading={busyAction === 'activate'}
                                    onClick={() =>
                                      runAction('activate', async () => {
                                        const updated = await activateModel(model.id);
                                        setActiveModelId(updated.id);
                                        await refreshState();
                                      })
                                    }
                                  />
                                  <Button
                                    label="Load"
                                    size="sm"
                                    variant="secondary"
                                    isDisabled={!runtime?.running || isLoaded || isLoading}
                                    isLoading={busyAction === `load:${model.id}`}
                                    onClick={() => handleLoadRouterModel(model)}
                                  />
                                  <Button
                                    label="Unload"
                                    size="sm"
                                    variant="ghost"
                                    isDisabled={!runtime?.running || !isLoaded}
                                    isLoading={busyAction === `unload:${model.id}`}
                                    onClick={() => handleUnloadRouterModel(model)}
                                  />
                                </HStack>
                              </VStack>
                            </Card>
                          );
                        })}
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
                      input={<ChatComposerInput />}
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
                              onClick: () =>
                                runAction('activate', async () => {
                                  await activateModel(model.id);
                                  await refreshState();
                                }),
                            }))}
                          />
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
                      />
                    ))}
                  </ChatMessageList>
                </ChatLayout>
              </StackItem>

              <VStack gap={4} className="nelle-search-panel nelle-panel-content nelle-scroll">
                <HStack gap={2} vAlign="center">
                  <Icon icon={MagnifyingGlassIcon} size="sm" color="secondary" />
                  <Heading level={3}>Hugging Face GGUF search</Heading>
                </HStack>
                <TextInput
                  label="Search query"
                  value={searchQuery}
                  onChange={setSearchQuery}
                  placeholder="qwen coder gguf"
                />
                <Button
                  label="Search GGUF models"
                  variant="primary"
                  icon={<Icon icon={MagnifyingGlassIcon} size="sm" />}
                  isLoading={isSearching}
                  onClick={handleSearch}
                />
                <VStack gap={3}>
                  {searchResults.map(result => (
                    <Card key={result.id} padding={3}>
                      <VStack gap={2}>
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
                                  {quant.files.length > 1
                                    ? ` across ${quant.files.length} files`
                                    : ''}
                                </Text>
                              </VStack>
                            </StackItem>
                            <Button
                              label="Use"
                              size="sm"
                              variant="secondary"
                              isLoading={busyAction === `use:${result.id}:${quant.quant}`}
                              onClick={() =>
                                runAction(`use:${result.id}:${quant.quant}`, async () => {
                                  await useHuggingFaceModel({
                                    repoId: result.id,
                                    quant: quant.quant,
                                  });
                                  await refreshState();
                                })
                              }
                            />
                          </HStack>
                        ))}
                      </VStack>
                    </Card>
                  ))}
                </VStack>
              </VStack>
            </HStack>
          </LayoutContent>
        }
      />
    </AppShell>
  );
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
  onNewConversation,
  isNewConversationBusy,
}: {
  onExpand: () => void;
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
        tooltip="Expand sidebar to edit settings"
        size="sm"
        variant="ghost"
        icon={<Icon icon={Cog6ToothIcon} size="sm" />}
        onClick={onExpand}
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
  onDelete,
}: {
  conversations: ConversationListItem[];
  query: string;
  activeConversationId: string;
  onSelect: (conversationId: string) => void | Promise<void>;
  onTogglePin: (conversation: ConversationListItem) => void | Promise<void>;
  onRename: (conversation: ConversationListItem) => void | Promise<void>;
  onReset: (conversationId: string) => void | Promise<void>;
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
  onDelete,
}: {
  conversation: ConversationListItem;
  isActive: boolean;
  onSelect: (conversationId: string) => void | Promise<void>;
  onTogglePin: (conversation: ConversationListItem) => void | Promise<void>;
  onRename: (conversation: ConversationListItem) => void | Promise<void>;
  onReset: (conversationId: string) => void | Promise<void>;
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
}: {
  message: ApiChatMessage;
  models: ConfiguredModel[];
  isActionDisabled: boolean;
  onRegenerate: (message: ApiChatMessage, modelId?: string) => void | Promise<void>;
  onCopy: (message: ApiChatMessage) => void | Promise<void>;
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

function renderMessageFooter(input: {
  message: ApiChatMessage;
  models: ConfiguredModel[];
  isActionDisabled: boolean;
  onRegenerate: (message: ApiChatMessage, modelId?: string) => void | Promise<void>;
  onCopy: (message: ApiChatMessage) => void | Promise<void>;
}) {
  const {message, models, isActionDisabled, onRegenerate, onCopy} = input;
  const hasPerformance = hasChatPerformance(message.performance);
  const modelLabel =
    message.role === 'assistant'
      ? (message.modelAliasSnapshot ??
        models.find(model => model.id === message.modelId)?.name ??
        message.modelRuntimeId ??
        message.modelId)
      : undefined;
  if (!hasPerformance && !modelLabel && message.role !== 'assistant') {
    return undefined;
  }

  return (
    <HStack gap={1} vAlign="center" wrap="wrap">
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

async function delay(milliseconds: number): Promise<void> {
  await new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
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
