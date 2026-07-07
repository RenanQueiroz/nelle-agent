export type RuntimeInstallMode = 'source-master' | 'github-release' | 'external';

export type RuntimeStatus = {
  platform: NodeJS.Platform;
  arch: string;
  dataDir: string;
  binaryPath: string | null;
  installMode: RuntimeInstallMode;
  installed: boolean;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  running: boolean;
  pid: number | null;
  host: string;
  port: number;
  activeModelId: string | null;
  lastError: string | null;
};

export type ModelParams = {
  contextSize: number;
  gpuLayers: number;
  threads?: number;
  batchSize?: number;
};

export type ConfiguredModel = {
  id: string;
  name: string;
  presetName: string;
  source: 'huggingface' | 'local';
  repoId?: string;
  filename?: string;
  path: string;
  params: ModelParams;
  createdAt: string;
};

export type HuggingFaceFile = {
  filename: string;
  size: number | null;
};

export type HuggingFaceModelResult = {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags: string[];
  files: HuggingFaceFile[];
};

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  toolCalls?: ToolCallEvent[];
};

export type ToolCallEvent = {
  name: string;
  target?: string;
  status: 'running' | 'complete' | 'error';
  duration?: string;
};

export type ChatStreamEvent =
  | {type: 'user_message'; message: ChatMessage}
  | {type: 'assistant_start'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'assistant_delta'; id: string; delta: string}
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
    modelsMax: 1;
  };
  chat: ChatMessage[];
};
