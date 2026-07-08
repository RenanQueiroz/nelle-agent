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

export async function clearChat(): Promise<void> {
  await apiDelete('/api/chat/messages');
}

export async function streamChat(
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

  const reader = response.body.getReader();
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
