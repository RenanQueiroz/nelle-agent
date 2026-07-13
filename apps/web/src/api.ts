import type {SlashCommandRegistry} from '../../../packages/shared/src/commands.ts';
import type {ConversationDiagnostics} from '../../../packages/shared/src/conversations.ts';
import type {ContextUsageStatus} from '../../../packages/shared/src/context.ts';
import type {DisplayPreferences} from '../../../packages/shared/src/displayPreferences.ts';

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
  /** What llama.cpp reports it is running at. Absent until the model is loaded. */
  contextWindow?: number;
  /** The window the model was trained for; the ceiling a cap is measured against. */
  contextTrain?: number;
  parameterCount?: number;
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
  /** Computed by the server from the chat template; `null` when unknown. */
  canReason: boolean | null;
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
    /** The `c` cap the user configured, absent when llama.cpp picks the window. */
    contextSize?: number;
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
  /** From Hugging Face's own parsed GGUF header. Absent when it could not read one. */
  architecture?: string;
  parameterCount?: number;
  contextTrain?: number;
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

/** What a chat request carries: a reference, not the bytes. */
export type ChatAttachmentReference = {
  uploadId: string;
  renderPdfAsImages?: boolean;
};

export type UploadedAttachment = {
  uploadId: string;
  kind: 'text' | 'pdf' | 'image';
  name: string;
  mimeType?: string;
  sizeBytes: number;
  textPreview?: string;
  pageCount?: number;
  /** PDFs only. `false` means a scan, which reaches the model as page images. */
  hasTextLayer?: boolean;
  warnings: string[];
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
  | {
      type: 'model.loading';
      conversationId: string;
      modelId: string;
      status: string;
      progress?: number;
      createdAt: string;
    }
  | {type: 'message.user.created'; message: ChatMessage}
  | {type: 'message.assistant.started'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'message.assistant.delta'; id: string; delta: string; isReasoning: false}
  | {type: 'message.assistant.reasoning_delta'; id: string; delta: string; isReasoning: true}
  | {type: 'message.assistant.completed'; message: ChatMessage}
  | {type: 'performance.updated'; id: string; performance: ChatPerformance}
  | {type: 'tool_call.updated'; call: NonNullable<ChatMessage['toolCalls']>[number]}
  | {
      type: 'conversation.updated';
      conversationId: string;
      title?: string;
      titleSource?: ConversationListItem['titleSource'];
      activeLeafPiEntryId?: string;
      updatedAt: string;
    }
  | ({type: 'run.warning'} & NelleWarning)
  | ({type: 'error'} & NelleError);

/** Mirrors `packages/shared/src/contracts.ts`; the web bundle stays zod-free. */
export type NelleError = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  logRef?: string;
};

export type NelleWarning = {
  code: string;
  message: string;
  detail?: string;
};

export type AbortConversationResponse = {
  ok: boolean;
  aborted: boolean;
  /** Server-side abort warnings carry the full NelleError shape. */
  warning?: NelleError;
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
  /** Derived by the server from the shared thresholds. */
  status?: ContextUsageStatus;
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
  /** Rendered by the client verbatim; the server applied the projection rules. */
  messages: ChatMessage[];
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
    /** `null` when llama.cpp has never reported props for the model. */
    canAttachImages: boolean | null;
    /** `null` when llama.cpp has never reported a chat template for the model. */
    canReason: boolean | null;
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

/**
 * How llama.cpp is launched is a settings group now, not a corner of `state.json` behind
 * a hand-written route. `GET /api/runtime` still *reports* the limits (it reports what
 * the router will be launched with), so only the write moved.
 */
export async function updateRuntimeSettings(input: {
  modelsMax?: number;
  sleepIdleSeconds?: number;
}): Promise<{modelsMax: number; sleepIdleSeconds: number}> {
  return apiPatch<{modelsMax: number; sleepIdleSeconds: number}>('/api/settings/runtime', input);
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

/**
 * The reasoning budgets are a settings group now, not a corner of `state.json` behind a
 * hand-written route -- so they are read and written like every other group, with flat
 * keys, and they render themselves from the served schema.
 */
export async function fetchReasoningBudgets(): Promise<ReasoningBudgets> {
  return apiGet<ReasoningBudgets>('/api/settings/reasoning');
}

export async function updateReasoningBudgets(budgets: ReasoningBudgets): Promise<ReasoningBudgets> {
  return apiPatch<ReasoningBudgets>('/api/settings/reasoning', budgets);
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

export type InvalidModelParam = {
  key: string;
  reason: 'unknown' | 'reserved' | 'duplicate' | 'syntax';
  message: string;
  /** The nearest real llama.cpp key, when one is close enough to offer. */
  suggestion?: string;
};

/**
 * A save the server refused because of the keys in it. The rows are keyed by
 * `key`, so the client marks them; it does not decide which are wrong.
 */
export class ModelParamsError extends Error {
  readonly invalidParams: InvalidModelParam[];

  constructor(message: string, invalidParams: InvalidModelParam[]) {
    super(message);
    this.name = 'ModelParamsError';
    this.invalidParams = invalidParams;
  }
}

async function patchModelParams<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.ok) {
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }
  let refusal: {error?: {message?: string}; invalidParams?: InvalidModelParam[]} | undefined;
  try {
    refusal = JSON.parse(text) as typeof refusal;
  } catch {
    // Not JSON. Fall through to the raw text.
  }
  if (refusal?.invalidParams?.length) {
    throw new ModelParamsError(
      refusal.error?.message ?? 'Invalid parameters.',
      refusal.invalidParams,
    );
  }
  throw new Error(refusal?.error?.message || text || `Request failed: ${response.status}`);
}

export async function updateGlobalModelParams(
  params: Record<string, string>,
): Promise<Record<string, string>> {
  const response = await patchModelParams<{globalModelParams: Record<string, string>}>(
    '/api/models/global-params',
    {params},
  );
  return response.globalModelParams;
}

export async function updateConfiguredModel(
  id: string,
  input: {name?: string; params?: Record<string, string>},
): Promise<ConfiguredModel> {
  const response = await patchModelParams<{model: ConfiguredModel}>(
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

/**
 * Re-exported from the contract, never re-declared. This was a hand-written copy of a shape the
 * server owns -- the exact thing serving an OpenAPI document exists to prevent, and the reason
 * a second client had to reverse-engineer it.
 */
export type {ConversationDiagnostics};

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

export async function streamConversationChat(
  conversationId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  attachments: ChatAttachmentReference[] = [],
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

/** The slash-command allowlist and guidance copy, owned by the server. */
export async function fetchSlashCommands(): Promise<SlashCommandRegistry> {
  const response = await fetch('/api/commands');
  if (!response.ok) {
    throw new Error(`Command registry request failed: ${response.status}`);
  }
  return (await response.json()) as SlashCommandRegistry;
}

/**
 * Favourite models. The display toggles used to be here too; they are the `display`
 * settings group now, and render themselves from the served schema.
 */
export type Preferences = {favoriteModelIds: string[]};

export async function fetchDisplayPreferences(): Promise<DisplayPreferences> {
  const response = await fetch('/api/settings/display');
  if (!response.ok) {
    throw new Error(`Display preferences request failed: ${response.status}`);
  }
  return (await response.json()) as DisplayPreferences;
}

export async function updateDisplayPreferences(
  input: Partial<DisplayPreferences>,
): Promise<DisplayPreferences> {
  const response = await fetch('/api/settings/display', {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Display preferences update failed: ${response.status}`);
  }
  return (await response.json()) as DisplayPreferences;
}

export async function fetchPreferences(): Promise<Preferences> {
  const response = await fetch('/api/settings/preferences');
  if (!response.ok) {
    throw new Error(`Preferences request failed: ${response.status}`);
  }
  return (await response.json()) as Preferences;
}

export async function updatePreferences(input: Partial<Preferences>): Promise<Preferences> {
  const response = await fetch('/api/settings/preferences', {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Preferences update failed: ${response.status}`);
  }
  return (await response.json()) as Preferences;
}

export type SettingsFieldSchema =
  | {
      key: string;
      label: string;
      help: string;
      type: 'text' | 'textarea';
      default: string;
      maxLength?: number;
      /** Show an estimated token cost beneath the control. */
      tokenCost?: boolean;
    }
  | {
      key: string;
      label: string;
      help: string;
      type: 'number';
      default: number;
      min?: number;
      max?: number;
      step?: number;
      integer?: boolean;
    }
  | {key: string; label: string; help: string; type: 'boolean'; default: boolean}
  | {
      key: string;
      label: string;
      help: string;
      type: 'select';
      default: string;
      options: Array<{value: string; label: string}>;
    };

export type SettingsGroupSchema = {
  slug: string;
  title: string;
  description?: string;
  fields: SettingsFieldSchema[];
};

export type SettingsValue = string | number | boolean;
export type SettingsValues = Record<string, SettingsValue>;

/**
 * The server's field list, fetched rather than bundled.
 *
 * A client that renders this gets every future setting without a release, and
 * carries no copy of a label, a bound, or a default -- `GET /api/settings/<slug>`
 * returns effective values, so there is nothing here to fall out of date.
 */
export async function fetchSettingsSchema(): Promise<{sections: SettingsGroupSchema[]}> {
  const response = await fetch('/api/settings/schema');
  if (!response.ok) {
    throw new Error(`Settings schema request failed: ${response.status}`);
  }
  return (await response.json()) as {sections: SettingsGroupSchema[]};
}

export async function fetchSettingsGroup(slug: string): Promise<SettingsValues> {
  const response = await fetch(`/api/settings/${encodeURIComponent(slug)}`);
  if (!response.ok) {
    throw new Error(`Settings request failed: ${response.status}`);
  }
  return (await response.json()) as SettingsValues;
}

export async function updateSettingsGroup(
  slug: string,
  patch: SettingsValues,
): Promise<SettingsValues> {
  const response = await fetch(`/api/settings/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    // The server names the field it refused; that message is the whole point.
    throw new Error(
      await nelleErrorMessage(response, `Settings update failed (${response.status}).`),
    );
  }
  return (await response.json()) as SettingsValues;
}

/** Sends the bytes. The server classifies, extracts, and refuses. */
export async function uploadAttachment(
  file: File,
  conversationId?: string,
): Promise<UploadedAttachment> {
  const body = new FormData();
  if (conversationId) {
    body.append('conversationId', conversationId);
  }
  body.append('file', file, file.name);
  const response = await fetch('/api/uploads', {method: 'POST', body});
  if (!response.ok) {
    throw new Error(await uploadErrorMessage(response, file.name));
  }
  return (await response.json()) as UploadedAttachment;
}

export async function deleteUpload(uploadId: string): Promise<void> {
  await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {method: 'DELETE'});
}

/** The server sends a `NelleError`; show its message, not the status code. */
async function uploadErrorMessage(response: Response, fileName: string): Promise<string> {
  return nelleErrorMessage(response, `${fileName} could not be uploaded (${response.status}).`);
}

async function nelleErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {error?: {message?: string}};
    if (body.error?.message) {
      return body.error.message;
    }
  } catch {
    // A response that is not JSON. Fall through to the generic message.
  }
  return fallback;
}
