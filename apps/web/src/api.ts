export type RuntimeStatus = {
  platform: string;
  arch: string;
  dataDir: string;
  binaryPath: string | null;
  logPath: string;
  installMode: 'source-master' | 'github-release' | 'external';
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  running: boolean;
  pid: number | null;
  host: string;
  port: number;
  modelsMax: number;
  sleepIdleSeconds: number;
  activeModelId: string | null;
  lastError: string | null;
};

export type LlamaRouterProps = {
  role: string | null;
  maxInstances: number | null;
  modelsAutoload: boolean | null;
  runtime: RuntimeStatus;
  raw: unknown;
};

export type LlamaRouterModel = {
  sectionId: string;
  routerModelId?: string;
  alias: string;
  hfRepo?: string;
  status: string;
  progress?: number;
  aliases: string[];
  source?: string;
  canRemove?: boolean;
  architecture?: string;
  raw?: unknown;
};

export type LlamaRouterModelUpdate = {
  sectionId?: string;
  routerModelId?: string;
  alias?: string;
  hfRepo?: string;
  status?: string;
  progress?: number;
  aliases?: string[];
  source?: string;
  architecture?: string;
  error?: string;
  raw?: unknown;
};

export type LlamaRouterModelEvent = {
  eventType: string;
  model: LlamaRouterModelUpdate | null;
  raw: unknown;
};

export type LlamaModelProps = {
  modelId: string;
  modalities: {
    vision: boolean;
    audio: boolean;
    video: boolean;
  };
  contextWindow?: number;
  chatTemplate?: string;
  defaultGenerationSettings?: unknown;
  raw: unknown;
};

export type ConfiguredModel = {
  id: string;
  name: string;
  presetName: string;
  source: 'huggingface';
  repoId?: string;
  quant?: string;
  hfRef?: string;
  params: {
    contextSize: number;
    gpuLayers?: number;
    threads?: number;
    batchSize?: number;
    extra?: Record<string, string>;
  };
  createdAt: string;
};

export type HuggingFaceModelResult = {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags: string[];
  files: Array<{filename: string; size: number | null}>;
  quants: Array<{
    quant: string;
    size: number | null;
    files: Array<{filename: string; size: number | null}>;
  }>;
};

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  attachments?: AttachmentMetadata[];
  parentPiEntryId?: string;
  modelId?: string;
  modelRuntimeId?: string;
  modelAliasSnapshot?: string;
  regeneratesPiEntryId?: string;
  displayGroupId?: string;
  variantLabel?: string;
  performance?: ChatPerformance;
  /** Thinking text llama.cpp streamed as `reasoning_content`. */
  reasoning?: string;
  /** True while thinking deltas are still arriving for this message. */
  isReasoning?: boolean;
  toolCalls?: Array<{
    id: string;
    name: string;
    target?: string;
    status: 'running' | 'complete' | 'error';
    duration?: string;
    input?: string;
    output?: string;
    errorMessage?: string;
  }>;
};

export type ChatAttachmentInput = {
  id: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  text?: string;
  data?: string;
};

export type ChatPerformanceMetric = {
  tokens: number;
  /** Absent when the burst was too short for llama.cpp to time it. */
  tokensPerSecond?: number;
  milliseconds?: number;
  totalTokens?: number;
  cacheTokens?: number;
};

export type ChatPerformance = {
  source: 'llamacpp-slots' | 'llamacpp-timings';
  prompt?: ChatPerformanceMetric;
  generation?: ChatPerformanceMetric;
  tokensPerSecond?: number;
  generatedTokens?: number;
};

export type ChatStreamEvent =
  | {
      type: 'run.started';
      runId: string;
      conversationId: string;
      kind: 'chat' | 'regenerate' | 'compact' | 'title';
      modelId?: string;
      status: 'pending' | 'running';
      createdAt: string;
    }
  | {
      type: 'run.aborted';
      runId: string;
      conversationId: string;
      reason: 'user' | 'server' | 'runtime';
      createdAt: string;
    }
  | {
      type: 'run.completed';
      runId: string;
      conversationId: string;
      status: 'completed' | 'aborted' | 'failed';
      error?: {code: string; message: string; retryable?: boolean};
      createdAt: string;
    }
  | ({
      type: 'context.updated';
      conversationId: string;
      createdAt: string;
    } & ConversationContextUsage)
  | {
      type: 'compact.started';
      runId: string;
      conversationId: string;
      instructions?: string;
      createdAt: string;
    }
  | {
      type: 'compact.completed';
      runId: string;
      conversationId: string;
      compacted: boolean;
      tokensBefore?: number;
      firstKeptEntryId?: string;
      summaryPreview?: string;
      createdAt: string;
    }
  | {
      type: 'compact.failed';
      runId: string;
      conversationId: string;
      error: {code: string; message: string; retryable?: boolean};
      createdAt: string;
    }
  | {type: 'user_message'; message: ChatMessage}
  | {type: 'assistant_start'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'assistant_delta'; id: string; delta: string}
  | {type: 'assistant_reasoning'; id: string; delta: string}
  | {type: 'assistant_metrics'; id: string; performance: ChatPerformance}
  | {type: 'tool'; call: NonNullable<ChatMessage['toolCalls']>[number]}
  | {type: 'conversation_title'; conversationId: string; title: string}
  | {type: 'warning'; message: string}
  | {type: 'message.assistant.completed'; message: ChatMessage}
  | {type: 'done'; message: ChatMessage}
  | ({type: 'error'} & NelleWarning);

export type NelleWarning = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  logRef?: string;
};

export type AbortConversationResponse = {
  ok: boolean;
  aborted: boolean;
  warning?: NelleWarning;
  runId?: string;
  snapshot?: ConversationSnapshot;
};

export type ConversationListItem = {
  id: string;
  title: string;
  titleSource: 'generated' | 'user' | 'imported' | 'fallback';
  pinned: boolean;
  status: 'ready' | 'running' | 'compacting' | 'aborting' | 'unavailable';
  updatedAt: string;
  defaultModelId?: string;
};

export type ConversationEntryProjection = {
  conversationId: string;
  piEntryId: string;
  parentPiEntryId?: string;
  entryType: string;
  role?: ChatMessage['role'];
  textPreview?: string;
  createdAt: string;
  modelId?: string;
  modelRuntimeId?: string;
  modelAliasSnapshot?: string;
  regeneratesPiEntryId?: string;
  displayGroupId?: string;
  performance?: unknown;
  toolCalls?: unknown;
  attachmentSummary?: unknown;
  reasoning?: string;
};

export type ConversationContextUsage = {
  usedTokens?: number;
  totalTokens?: number;
  source?: 'estimate' | 'prompt_progress' | 'timings' | 'pi';
  updatedAt?: string;
};

/** Mirrors `packages/shared/src/reasoning.ts`; the web bundle stays zod-free. */
export const REASONING_LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/** Reasoning tokens allowed before llama.cpp closes the thinking block; 0 is unlimited. */
export type ReasoningBudgets = {low: number; medium: number; high: number};

export const UNLIMITED_REASONING_BUDGET = 0;
export const MAX_REASONING_BUDGET = 65_536;

/** The same tiers llama.cpp's built-in UI ships with; `max` is uncapped. */
export const DEFAULT_REASONING_BUDGETS: ReasoningBudgets = {
  low: 512,
  medium: 2048,
  high: 8192,
};

export type ConversationSnapshot = {
  conversation: ConversationListItem & {
    piSessionId?: string;
    activeLeafPiEntryId?: string;
    parentConversationId?: string;
    forkedFromPiEntryId?: string;
    forkKind?: 'fork' | 'clone';
    reasoningLevel: ReasoningLevel;
  };
  entries: ConversationEntryProjection[];
  activePathEntryIds: string[];
  attachments: AttachmentMetadata[];
  context: ConversationContextUsage;
  models: {
    selectedModelId?: string;
    defaultModelId?: string;
    available: Array<{id: string; alias: string; status?: string}>;
  };
  capabilities: {
    canSend: boolean;
    canAbort: boolean;
    canCompact: boolean;
    canFork: boolean;
    canRepair: boolean;
    canAttachImages: boolean;
    canAttachText: boolean;
  };
  errors: Array<{code: string; message: string; retryable?: boolean}>;
};

export type AttachmentMetadata = {
  id: string;
  conversationId: string;
  piEntryId?: string;
  uploadId?: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  textPreview?: string;
  processing?: unknown;
  createdAt: string;
};

export type AppStateResponse = {
  state: {
    activeModelId: string | null;
    models: ConfiguredModel[];
    globalModelParams?: Record<string, string>;
    reasoning?: {budgets: ReasoningBudgets};
    runtime?: {
      host: string;
      port: number;
      modelsMax: number;
      sleepIdleSeconds: number;
    };
    chat: ChatMessage[];
  };
  runtime: RuntimeStatus;
  hostTools?: HostToolSettings;
};

export type HostToolSettings = {
  enabled: boolean;
  acknowledged: boolean;
  updatedAt: string;
};

export async function getState(): Promise<AppStateResponse> {
  return apiGet('/api/state');
}

export async function getRuntime(latest = false): Promise<RuntimeStatus> {
  return apiGet(`/api/runtime${latest ? '?latest=1' : ''}`);
}

export async function installRuntime(): Promise<RuntimeStatus> {
  return apiPost('/api/runtime/install');
}

export async function startRuntime(): Promise<RuntimeStatus> {
  return apiPost('/api/runtime/start');
}

export async function stopRuntime(): Promise<RuntimeStatus> {
  return apiPost('/api/runtime/stop');
}

export async function getRuntimeLogs(): Promise<{path: string; text: string}> {
  return apiGet('/api/runtime/logs');
}

export async function updateRuntimeSettings(input: {
  modelsMax?: number;
  sleepIdleSeconds?: number;
}): Promise<AppStateResponse['state']['runtime']> {
  const response = await apiPatch<{runtime: AppStateResponse['state']['runtime']}>(
    '/api/runtime/settings',
    input,
  );
  return response.runtime;
}

export async function getHostToolSettings(): Promise<HostToolSettings> {
  const response = await apiGet<{hostTools: HostToolSettings}>('/api/settings/host-tools');
  return response.hostTools;
}

export async function updateHostToolSettings(input: {
  enabled?: boolean;
  acknowledged?: boolean;
}): Promise<HostToolSettings> {
  const response = await apiPatch<{hostTools: HostToolSettings}>('/api/settings/host-tools', input);
  return response.hostTools;
}

export async function updateReasoningBudgets(budgets: ReasoningBudgets): Promise<ReasoningBudgets> {
  const response = await apiPatch<{budgets: ReasoningBudgets}>('/api/settings/reasoning', {
    budgets,
  });
  return response.budgets;
}

export async function setConversationReasoningLevel(
  id: string,
  level: ReasoningLevel,
): Promise<ConversationSnapshot> {
  const response = await apiPut<{snapshot: ConversationSnapshot}>(
    `/api/conversations/${encodeURIComponent(id)}/reasoning`,
    {level},
  );
  return response.snapshot;
}

export async function getLlamaRouterProps(): Promise<LlamaRouterProps> {
  return apiGet('/api/llama/props');
}

export async function getLlamaModels(): Promise<LlamaRouterModel[]> {
  const response = await apiGet<{models: LlamaRouterModel[]}>('/api/llama/models');
  return response.models;
}

export async function reloadLlamaModels(): Promise<LlamaRouterModel[]> {
  const response = await apiPost<{models: LlamaRouterModel[]}>('/api/llama/models/reload');
  return response.models;
}

export async function getLlamaModelProps(modelId: string): Promise<LlamaModelProps> {
  return apiGet(`/api/llama/models/${encodeURIComponent(modelId)}/props`);
}

export async function loadLlamaModel(modelId: string): Promise<void> {
  await apiPost(`/api/llama/models/${encodeURIComponent(modelId)}/load`);
}

export async function unloadLlamaModel(modelId: string): Promise<void> {
  await apiPost(`/api/llama/models/${encodeURIComponent(modelId)}/unload`);
}

export async function tokenizeWithLlama(content: string): Promise<{tokens: number; raw: unknown}> {
  return apiPost('/api/llama/tokenize', {content});
}

export function subscribeLlamaModelEvents(
  onEvent: (event: LlamaRouterModelEvent) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource('/api/llama/models/events');
  const eventTypes = [
    'message',
    'model_status',
    'model_loading',
    'model_loaded',
    'model_unloaded',
    'model_error',
    'download_progress',
  ];
  const handleEvent = (event: MessageEvent<string>) => {
    onEvent(normalizeLlamaModelEvent(event.type, event.data));
  };
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, handleEvent);
  }
  source.onerror = () => {
    onError?.();
  };
  return () => {
    for (const eventType of eventTypes) {
      source.removeEventListener(eventType, handleEvent);
    }
    source.close();
  };
}

/**
 * llama.cpp's router streams `/models/sse` as:
 *   {"model":"<id>","event":"status_change",
 *    "data":{"status":"loading","progress":{"stages":[...],"current":"text_model","value":0.67}}}
 *
 * The model id is a top-level string and the progress fraction is nested under
 * `data.progress.value`, so both the id and the percentage must be read from
 * outside the `data` payload.
 */
function normalizeLlamaModelEvent(eventType: string, rawData: string): LlamaRouterModelEvent {
  const raw = parseEventData(rawData);
  const dataPayload = objectProp(raw, 'data');
  const modelPayload = objectProp(raw, 'model') ?? dataPayload ?? raw;
  const id =
    stringProp(raw, 'model') ??
    stringProp(modelPayload, 'sectionId') ??
    stringProp(modelPayload, 'section_id') ??
    stringProp(modelPayload, 'routerModelId') ??
    stringProp(modelPayload, 'router_model_id') ??
    stringProp(modelPayload, 'id') ??
    stringProp(modelPayload, 'model') ??
    stringProp(modelPayload, 'name');
  if (!id) {
    return {eventType, model: null, raw};
  }

  const statusPayload = objectProp(modelPayload, 'status') ?? objectProp(dataPayload, 'status');
  const status =
    stringProp(dataPayload, 'status') ??
    stringProp(statusPayload, 'value') ??
    stringProp(modelPayload, 'status') ??
    statusFromRouterEventType(eventType);
  const progress =
    numberProp(objectProp(dataPayload, 'progress'), 'value') ??
    numberProp(dataPayload, 'progress') ??
    numberProp(modelPayload, 'progress') ??
    numberProp(statusPayload, 'progress') ??
    numberProp(raw, 'progress') ??
    numberProp(raw, 'pct');

  return {
    eventType,
    raw,
    model: {
      sectionId: id,
      routerModelId: id,
      alias: stringProp(modelPayload, 'alias') ?? stringProp(modelPayload, 'name'),
      hfRepo:
        stringProp(modelPayload, 'hfRepo') ??
        stringProp(modelPayload, 'hf_repo') ??
        stringProp(modelPayload, 'source'),
      status,
      progress,
      aliases: arrayStringProp(modelPayload, 'aliases'),
      source: stringProp(modelPayload, 'source'),
      architecture: stringProp(modelPayload, 'architecture'),
      error: stringProp(modelPayload, 'error') ?? stringProp(raw, 'error'),
      raw,
    },
  };
}

function statusFromRouterEventType(eventType: string): string | undefined {
  if (eventType === 'model_loading' || eventType === 'download_progress') {
    return 'loading';
  }
  if (eventType === 'model_loaded') {
    return 'loaded';
  }
  if (eventType === 'model_unloaded') {
    return 'unloaded';
  }
  if (eventType === 'model_error') {
    return 'failed';
  }
  return undefined;
}

function parseEventData(value: string): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {message: value};
  }
}

function objectProp(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return prop != null && typeof prop === 'object' ? (prop as Record<string, unknown>) : undefined;
}

function stringProp(value: unknown, key: string): string | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'string' ? prop : undefined;
}

function numberProp(value: unknown, key: string): number | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === 'number' && Number.isFinite(prop) ? prop : undefined;
}

function arrayStringProp(value: unknown, key: string): string[] | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  const prop = (value as Record<string, unknown>)[key];
  return Array.isArray(prop) ? prop.filter(item => typeof item === 'string') : undefined;
}

export async function searchHuggingFace(query: string): Promise<HuggingFaceModelResult[]> {
  const response = await apiGet<{results: HuggingFaceModelResult[]}>(
    `/api/huggingface/search?q=${encodeURIComponent(query)}`,
  );
  return response.results;
}

export async function useHuggingFaceModel(input: {
  repoId: string;
  quant: string;
  name?: string;
}): Promise<ConfiguredModel> {
  const response = await apiPost<{model: ConfiguredModel}>('/api/huggingface/use', input);
  return response.model;
}

export async function updateGlobalModelParams(
  params: Record<string, string>,
): Promise<Record<string, string>> {
  const response = await apiPatch<{globalModelParams: Record<string, string>}>(
    '/api/models/global-params',
    {params},
  );
  return response.globalModelParams;
}

export async function updateConfiguredModel(
  id: string,
  input: {name?: string; params?: Record<string, string>},
): Promise<ConfiguredModel> {
  const response = await apiPatch<{model: ConfiguredModel}>(
    `/api/models/${encodeURIComponent(id)}`,
    input,
  );
  return response.model;
}

export async function duplicateConfiguredModel(id: string): Promise<ConfiguredModel> {
  const response = await apiPost<{model: ConfiguredModel}>(
    `/api/models/${encodeURIComponent(id)}/duplicate`,
  );
  return response.model;
}

export async function deleteConfiguredModel(id: string): Promise<void> {
  await apiDelete(`/api/models/${encodeURIComponent(id)}`);
}

export async function activateModel(id: string): Promise<ConfiguredModel> {
  const response = await apiPost<{model: ConfiguredModel}>(
    `/api/models/${encodeURIComponent(id)}/activate`,
  );
  return response.model;
}

export type ConversationPage = {
  conversations: ConversationListItem[];
  nextCursor?: string;
  /** Every conversation matching the search, not only the ones on this page. */
  total: number;
};

export async function getConversations(
  input: {search?: string; cursor?: string; limit?: number} = {},
): Promise<ConversationPage> {
  const query = new URLSearchParams();
  if (input.search) {
    query.set('search', input.search);
  }
  if (input.cursor) {
    query.set('cursor', input.cursor);
  }
  if (input.limit != null) {
    query.set('limit', String(input.limit));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return apiGet<ConversationPage>(`/api/conversations${suffix}`);
}

export async function createConversation(input: {
  title?: string;
  defaultModelId?: string | null;
}): Promise<ConversationListItem> {
  const response = await apiPost<{conversation: ConversationListItem}>('/api/conversations', input);
  return response.conversation;
}

export async function updateConversation(
  id: string,
  input: {title?: string; defaultModelId?: string | null},
): Promise<ConversationListItem> {
  const response = await apiPatch<{conversation: ConversationListItem}>(
    `/api/conversations/${encodeURIComponent(id)}`,
    input,
  );
  return response.conversation;
}

export async function setConversationPinned(
  id: string,
  pinned: boolean,
): Promise<ConversationListItem> {
  const response = await apiPost<{conversation: ConversationListItem}>(
    `/api/conversations/${encodeURIComponent(id)}/${pinned ? 'pin' : 'unpin'}`,
  );
  return response.conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  await apiDelete(`/api/conversations/${encodeURIComponent(id)}`);
}

export type ConversationDiagnostics = {
  conversationId: string;
  status: ConversationListItem['status'];
  piSessionPath?: string;
  piSessionId?: string;
  exists: boolean;
  reason?: string;
  sizeBytes?: number;
  projectionEntryCount: number;
  attachmentCount: number;
  toolAuditCount: number;
};

export async function getConversationDiagnostics(id: string): Promise<ConversationDiagnostics> {
  const response = await apiGet<{diagnostics: ConversationDiagnostics}>(
    `/api/conversations/${encodeURIComponent(id)}/diagnostics`,
  );
  return response.diagnostics;
}

/** Succeeds only if the Pi session file is readable again. */
export async function repairConversation(id: string): Promise<ConversationSnapshot> {
  const response = await apiPost<{snapshot: ConversationSnapshot}>(
    `/api/conversations/${encodeURIComponent(id)}/repair`,
  );
  return response.snapshot;
}

/** Rebuilds a Pi session from Nelle's stored messages. Lossy; warn first. */
export async function rebuildConversation(id: string): Promise<ConversationSnapshot> {
  const response = await apiPost<{snapshot: ConversationSnapshot}>(
    `/api/conversations/${encodeURIComponent(id)}/rebuild`,
  );
  return response.snapshot;
}

export async function deleteAllConversations(): Promise<void> {
  await apiDelete('/api/conversations');
}

export async function exportConversationArchive(id: string): Promise<Blob> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/export`, {
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.blob();
}

export async function importConversationArchive(file: Blob): Promise<ConversationSnapshot> {
  const response = await fetch('/api/conversations/import', {
    method: 'POST',
    headers: {'content-type': 'application/zip'},
    body: file,
  });
  const payload = await parseJson<{
    conversation: ConversationListItem;
    snapshot: ConversationSnapshot;
  }>(response);
  return payload.snapshot;
}

export async function getConversation(id: string): Promise<ConversationSnapshot> {
  const response = await apiGet<{snapshot: ConversationSnapshot}>(
    `/api/conversations/${encodeURIComponent(id)}`,
  );
  return response.snapshot;
}

export async function forkConversation(
  id: string,
  entryId: string,
  title?: string,
): Promise<ConversationSnapshot> {
  const response = await apiPost<{
    conversation: ConversationListItem;
    snapshot: ConversationSnapshot;
  }>(`/api/conversations/${encodeURIComponent(id)}/fork`, title ? {entryId, title} : {entryId});
  return response.snapshot;
}

export async function cloneConversation(
  id: string,
  entryId?: string,
  title?: string,
): Promise<ConversationSnapshot> {
  const response = await apiPost<{
    conversation: ConversationListItem;
    snapshot: ConversationSnapshot;
  }>(`/api/conversations/${encodeURIComponent(id)}/clone`, {entryId, title});
  return response.snapshot;
}

export async function clearConversation(id: string): Promise<void> {
  await apiDelete(`/api/conversations/${encodeURIComponent(id)}/messages`);
}

export async function abortConversation(id: string): Promise<AbortConversationResponse> {
  return apiPost(`/api/conversations/${encodeURIComponent(id)}/abort`);
}

export async function abortConversationRun(
  id: string,
  runId: string,
): Promise<AbortConversationResponse & {runId: string}> {
  return apiPost(
    `/api/conversations/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/abort`,
  );
}

export async function compactConversation(
  id: string,
  instructions?: string,
  signal?: AbortSignal,
): Promise<{ok: boolean; compacted: boolean; snapshot: ConversationSnapshot}> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/compact`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(instructions ? {instructions} : {}),
    signal,
  });
  return parseJson(response);
}

export async function streamCompactConversation(
  id: string,
  instructions: string | undefined,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/compact/stream`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(instructions ? {instructions} : {}),
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Compact request failed: ${response.status}`);
  }

  await readEventStream(response, onEvent);
}

export async function abortConversationCompaction(
  id: string,
): Promise<AbortConversationResponse & {snapshot: ConversationSnapshot}> {
  return apiPost(`/api/conversations/${encodeURIComponent(id)}/compact/abort`);
}

export async function clearChat(): Promise<void> {
  await apiDelete('/api/chat/messages');
}

export async function streamConversationChat(
  conversationId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  attachments: ChatAttachmentInput[] = [],
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/chat/stream`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message, attachments}),
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`);
  }

  await readEventStream(response, onEvent);
}

export async function streamRegenerateMessage(
  conversationId: string,
  messageId: string,
  modelId: string | undefined,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(
      messageId,
    )}/regenerate`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(modelId ? {modelId} : {}),
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Regenerate request failed: ${response.status}`);
  }

  await readEventStream(response, onEvent);
}

async function readEventStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Chat request did not return a response body.');
  }
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
      const line = chunk.split('\n').find(item => item.startsWith('data:'));
      if (!line) {
        continue;
      }
      onEvent(normalizeStreamEvent(JSON.parse(line.slice(5).trim())));
    }
  }
}

function normalizeStreamEvent(value: unknown): ChatStreamEvent {
  if (
    value != null &&
    typeof value === 'object' &&
    'data' in value &&
    value.data != null &&
    typeof value.data === 'object' &&
    'type' in value.data
  ) {
    return value.data as ChatStreamEvent;
  }
  return value as ChatStreamEvent;
}

export async function streamLegacyChat(
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({message}),
  });
  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`);
  }

  await readEventStream(response, onEvent);
}

async function apiGet<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return parseJson<T>(response);
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: body == null ? undefined : {'content-type': 'application/json'},
    body: body == null ? undefined : JSON.stringify(body),
  });
  return parseJson<T>(response);
}

async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: body == null ? undefined : {'content-type': 'application/json'},
    body: body == null ? undefined : JSON.stringify(body),
  });
  return parseJson<T>(response);
}

async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: body == null ? undefined : {'content-type': 'application/json'},
    body: body == null ? undefined : JSON.stringify(body),
  });
  return parseJson<T>(response);
}

async function apiDelete<T>(url: string): Promise<T> {
  const response = await fetch(url, {method: 'DELETE'});
  return parseJson<T>(response);
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
