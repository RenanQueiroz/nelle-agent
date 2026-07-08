import {useEffect, useMemo, useState} from 'react';

import {AppShell} from '@astryxdesign/core/AppShell';
import {HStack, VStack, StackItem, Layout, LayoutContent} from '@astryxdesign/core/Layout';
import {Text, Heading} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Banner} from '@astryxdesign/core/Banner';
import {Card} from '@astryxdesign/core/Card';
import {ClickableCard} from '@astryxdesign/core/ClickableCard';
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
  PlayIcon,
  PlusIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';

import {
  activateModel,
  addLocalModel,
  clearChat,
  getRuntime,
  getState,
  installRuntime,
  searchHuggingFace,
  startRuntime,
  stopRuntime,
  streamChat,
  useHuggingFaceModel,
  type ChatMessage as ApiChatMessage,
  type ChatPerformance,
  type ChatPerformanceMetric,
  type ChatStreamEvent,
  type ConfiguredModel,
  type HuggingFaceModelResult,
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

export function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [models, setModels] = useState<ConfiguredModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ApiChatMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState('qwen gguf');
  const [searchResults, setSearchResults] = useState<HuggingFaceModelResult[]>([]);
  const [localPath, setLocalPath] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [notice, setNotice] = useState<{
    type: 'info' | 'warning' | 'error' | 'success';
    text: string;
  } | null>(null);

  const activeModel = useMemo(
    () => models.find(model => model.id === activeModelId) ?? null,
    [activeModelId, models],
  );

  useEffect(() => {
    void refreshState();
  }, []);

  async function refreshState() {
    const response = await getState();
    setRuntime(response.runtime);
    setModels(response.state.models);
    setActiveModelId(response.state.activeModelId);
    setMessages(response.state.chat);
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

  async function handleChatSubmit(value: string) {
    const prompt = value.trim();
    if (!prompt || isStreaming) {
      return;
    }
    setIsStreaming(true);
    setNotice(null);
    try {
      await streamChat(prompt, applyChatEvent);
      setRuntime(await getRuntime());
    } catch (error) {
      setNotice({
        type: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsStreaming(false);
    }
  }

  async function handleResetConversation() {
    await runAction('reset-chat', async () => {
      await clearChat();
      setMessages([]);
      await refreshState();
      setNotice({type: 'success', text: 'Conversation reset.'});
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
                        isDisabled={!runtime?.installed || runtime.running || !activeModel}
                        isLoading={busyAction === 'start'}
                        onClick={() =>
                          runAction('start', async () => {
                            setRuntime(await startRuntime());
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
                    </HStack>
                  </VStack>
                </Card>

                <Card padding={3}>
                  <VStack gap={3}>
                    <Heading level={3}>Configured models</Heading>
                    {models.length === 0 && (
                      <Text type="supporting" color="secondary">
                        Search Hugging Face or add a local GGUF path to create the first model.
                      </Text>
                    )}
                    {models.map(model => (
                      <ClickableCard
                        key={model.id}
                        label={`Use ${model.name}`}
                        variant={model.id === activeModelId ? 'blue' : 'muted'}
                        padding={2}
                        onClick={() =>
                          runAction('activate', async () => {
                            const updated = await activateModel(model.id);
                            setActiveModelId(updated.id);
                            await refreshState();
                          })
                        }
                      >
                        <VStack gap={0.5}>
                          <Text type="label" weight="semibold">
                            {model.name}
                          </Text>
                          <Text type="supporting" color="secondary" className="nelle-code">
                            {model.hfRef ?? model.path ?? model.presetName}
                          </Text>
                        </VStack>
                      </ClickableCard>
                    ))}
                  </VStack>
                </Card>

                <Card padding={3}>
                  <VStack gap={3}>
                    <Heading level={3}>Local GGUF</Heading>
                    <TextInput
                      label="Local model path"
                      value={localPath}
                      onChange={setLocalPath}
                      placeholder="/path/to/model.gguf"
                    />
                    <Button
                      label="Add local model"
                      size="sm"
                      variant="secondary"
                      icon={<Icon icon={PlusIcon} size="sm" />}
                      isDisabled={!localPath.trim()}
                      isLoading={busyAction === 'add-local'}
                      onClick={() =>
                        runAction('add-local', async () => {
                          await addLocalModel({path: localPath});
                          setLocalPath('');
                          await refreshState();
                        })
                      }
                    />
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
                      onStop={() =>
                        setNotice({type: 'info', text: 'Stop is not wired in this POC yet.'})
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
