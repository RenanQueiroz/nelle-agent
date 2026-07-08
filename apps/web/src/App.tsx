import {useEffect, useMemo, useRef, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {HStack, VStack, StackItem, Layout, LayoutContent} from '@astryxdesign/core/Layout';
import {Text, Heading} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
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
import {Avatar} from '@astryxdesign/core/Avatar';
import {Icon} from '@astryxdesign/core/Icon';
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  ChatBubbleLeftRightIcon,
  CpuChipIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  PlayIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import {
  abortConversation,
  activateModel,
  clearConversation,
  createConversation,
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
  startRuntime,
  stopRuntime,
  streamConversationChat,
  unloadLlamaModel,
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
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [routerModels, setRouterModels] = useState<LlamaRouterModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('poc-default');
  const [messages, setMessages] = useState<ApiChatMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState('qwen gguf');
  const [searchResults, setSearchResults] = useState<HuggingFaceModelResult[]>([]);
  const [modelsMaxInput, setModelsMaxInput] = useState('1');
  const [sleepIdleInput, setSleepIdleInput] = useState('90');
  const [isLogVisible, setIsLogVisible] = useState(false);
  const [runtimeLogs, setRuntimeLogs] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const streamAbortController = useRef<AbortController | null>(null);
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
    if (!prompt || isStreaming) {
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

  async function handleResetConversation() {
    await runAction('reset-chat', async () => {
      await clearConversation(activeConversationId);
      setMessages([]);
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

  async function handleStopGeneration() {
    streamAbortController.current?.abort();
    await runAction('abort-chat', async () => {
      await abortConversation(activeConversationId);
      setIsStreaming(false);
      await refreshConversations(activeConversationId);
      setNotice({type: 'info', text: 'Generation stopped.'});
    });
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
              <VStack gap={4} className="nelle-side-panel nelle-panel-content nelle-scroll">
                <HStack gap={2} vAlign="center">
                  <Icon icon={ChatBubbleLeftRightIcon} size="md" color="accent" />
                  <VStack gap={0}>
                    <Heading level={2}>Nelle Agent</Heading>
                    <Text type="supporting" color="secondary">
                      Local Pi + llama.cpp POC
                    </Text>
                  </VStack>
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
                    <VStack gap={1}>
                      {conversations.map(conversation => (
                        <Button
                          key={conversation.id}
                          label={conversation.title}
                          size="sm"
                          variant={conversation.id === activeConversationId ? 'primary' : 'ghost'}
                          onClick={() => void handleSelectConversation(conversation.id)}
                        />
                      ))}
                    </VStack>
                  </VStack>
                </Card>

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
                                  model.id === activeModelId ? 'Selected' : `Select ${model.name}`
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
                      isDisabled={!activeModel || !runtime?.running || isStreaming}
                      isStopShown={isStreaming}
                      onStop={() => void handleStopGeneration()}
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
                          <Button
                            label="Reset conversation"
                            size="sm"
                            variant="ghost"
                            icon={<Icon icon={TrashIcon} size="sm" />}
                            isDisabled={messages.length === 0 || isStreaming}
                            isLoading={busyAction === 'reset-chat'}
                            onClick={handleResetConversation}
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
                      <RenderedMessage key={message.id} message={message} />
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

function RenderedMessage({message}: {message: ApiChatMessage}) {
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
            footer={formatChatPerformance(message.performance)}
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

function messagesFromSnapshot(snapshot: ConversationSnapshot): ApiChatMessage[] {
  return snapshot.entries
    .filter(entry => entry.entryType === 'message' && entry.role != null)
    .map(entry => ({
      id: entry.piEntryId,
      role: entry.role!,
      content: entry.textPreview ?? '',
      createdAt: entry.createdAt,
      performance: entry.performance as ChatPerformance | undefined,
      toolCalls: entry.toolCalls as ApiChatMessage['toolCalls'],
    }));
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

function formatChatPerformance(performance: ChatPerformance | undefined): string | undefined {
  if (!performance) {
    return undefined;
  }
  const parts = [
    formatPerformanceMetric('prompt', performance.prompt),
    formatPerformanceMetric(
      'gen',
      performance.generation ??
        (performance.tokensPerSecond == null
          ? undefined
          : {
              tokens: performance.generatedTokens ?? 0,
              tokensPerSecond: performance.tokensPerSecond,
            }),
    ),
  ].filter(part => part != null);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function formatPerformanceMetric(
  label: string,
  metric: ChatPerformanceMetric | undefined,
): string | undefined {
  if (!metric || !Number.isFinite(metric.tokensPerSecond)) {
    return undefined;
  }
  return `${label} ${formatTokensPerSecond(metric.tokensPerSecond)}`;
}

function formatTokensPerSecond(value: number): string {
  if (value == null || !Number.isFinite(value)) {
    return '0 tok/s';
  }
  return `${value.toFixed(2)} tok/s`;
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
