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
  performance?: ChatPerformance;
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

export type ChatPerformanceMetric = {
  tokens: number;
  tokensPerSecond: number;
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
  | {type: 'user_message'; message: ChatMessage}
  | {type: 'assistant_start'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'assistant_delta'; id: string; delta: string}
  | {type: 'assistant_metrics'; id: string; performance: ChatPerformance}
  | {type: 'tool'; call: NonNullable<ChatMessage['toolCalls']>[number]}
  | {type: 'warning'; message: string}
  | {type: 'done'; message: ChatMessage}
  | {type: 'error'; message: string};

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
  performance?: unknown;
  toolCalls?: unknown;
};

export type ConversationSnapshot = {
  conversation: ConversationListItem & {
    piSessionId?: string;
    activeLeafPiEntryId?: string;
    parentConversationId?: string;
    forkedFromPiEntryId?: string;
    forkKind?: 'fork' | 'clone';
  };
  entries: ConversationEntryProjection[];
  activePathEntryIds: string[];
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
    canAttachImages: boolean;
    canAttachText: boolean;
  };
  errors: Array<{code: string; message: string; retryable?: boolean}>;
};

export type AppStateResponse = {
  state: {
    activeModelId: string | null;
    models: ConfiguredModel[];
    runtime?: {
      host: string;
      port: number;
      modelsMax: number;
      sleepIdleSeconds: number;
    };
    chat: ChatMessage[];
  };
  runtime: RuntimeStatus;
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

export async function activateModel(id: string): Promise<ConfiguredModel> {
  const response = await apiPost<{model: ConfiguredModel}>(
    `/api/models/${encodeURIComponent(id)}/activate`,
  );
  return response.model;
}

export async function getConversations(): Promise<ConversationListItem[]> {
  const response = await apiGet<{conversations: ConversationListItem[]}>('/api/conversations');
  return response.conversations;
}

export async function createConversation(input: {
  title?: string;
  defaultModelId?: string | null;
}): Promise<ConversationListItem> {
  const response = await apiPost<{conversation: ConversationListItem}>('/api/conversations', input);
  return response.conversation;
}

export async function getConversation(id: string): Promise<ConversationSnapshot> {
  const response = await apiGet<{snapshot: ConversationSnapshot}>(
    `/api/conversations/${encodeURIComponent(id)}`,
  );
  return response.snapshot;
}

export async function clearConversation(id: string): Promise<void> {
  await apiDelete(`/api/conversations/${encodeURIComponent(id)}/messages`);
}

export async function abortConversation(id: string): Promise<{ok: boolean; aborted: boolean}> {
  return apiPost(`/api/conversations/${encodeURIComponent(id)}/abort`);
}

export async function clearChat(): Promise<void> {
  await apiDelete('/api/chat/messages');
}

export async function streamChat(
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
): Promise<void> {
  await streamConversationChat('poc-default', message, onEvent);
}

export async function streamConversationChat(
  conversationId: string,
  message: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/chat/stream`,
    {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({message}),
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed: ${response.status}`);
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
      onEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
    }
  }
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
