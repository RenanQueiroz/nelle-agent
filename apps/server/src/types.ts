export type RuntimeInstallMode = 'source-master' | 'github-release' | 'external';

export type RuntimeStatus = {
  platform: NodeJS.Platform;
  arch: string;
  dataDir: string;
  binaryPath: string | null;
  logPath: string;
  installMode: RuntimeInstallMode;
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

export type ModelParams = {
  contextSize: number;
  gpuLayers?: number;
  threads?: number;
  batchSize?: number;
};

export type ConfiguredModel = {
  id: string;
  name: string;
  presetName: string;
  source: 'huggingface';
  repoId?: string;
  quant?: string;
  hfRef?: string;
  params: ModelParams;
  createdAt: string;
};

export type HuggingFaceFile = {
  filename: string;
  size: number | null;
};

export type HuggingFaceQuant = {
  quant: string;
  size: number | null;
  files: HuggingFaceFile[];
};

export type HuggingFaceModelResult = {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags: string[];
  files: HuggingFaceFile[];
  quants: HuggingFaceQuant[];
};

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  performance?: ChatPerformance;
  toolCalls?: ToolCallEvent[];
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
  /**
   * Legacy generation throughput field. Kept so older persisted POC messages
   * can still render throughput metadata after the timing shape change.
   */
  tokensPerSecond?: number;
  /** Legacy generated token count matching tokensPerSecond. */
  generatedTokens?: number;
};

export type ToolCallEvent = {
  id: string;
  name: string;
  target?: string;
  status: 'running' | 'complete' | 'error';
  duration?: string;
  input?: string;
  output?: string;
  errorMessage?: string;
};

export type ChatStreamEvent =
  | {type: 'user_message'; message: ChatMessage}
  | {type: 'assistant_start'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'assistant_delta'; id: string; delta: string}
  | {type: 'assistant_metrics'; id: string; performance: ChatPerformance}
  | {type: 'tool'; call: ToolCallEvent}
  | {type: 'warning'; message: string}
  | {type: 'done'; message: ChatMessage}
  | {type: 'error'; message: string};

export type AppState = {
  version: 1;
  activeModelId: string | null;
  models: ConfiguredModel[];
  runtime: {
    host: string;
    port: number;
    modelsMax: number;
    sleepIdleSeconds: number;
  };
  chat: ChatMessage[];
};
