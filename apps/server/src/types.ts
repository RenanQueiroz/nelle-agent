import type {ChatAttachmentInput, NelleError} from '../../../packages/shared/src/contracts.ts';
import type {ReasoningSettings} from '../../../packages/shared/src/reasoning.ts';
import type {
  ChatMessage,
  ChatPerformance,
  ChatPerformanceMetric,
  ChatRole,
  ChatStreamEvent,
  ToolCallEvent,
} from '../../../packages/shared/src/streamEvents.ts';

export type {ChatAttachmentInput};

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
  /** llama.cpp's `/props` answer: the window a conversation on it actually gets. */
  contextWindow?: number;
  /** `n_ctx_train`: the window the model was trained for. Absent until loaded once. */
  contextTrain?: number;
  /** From the GGUF header of the blob llama.cpp loaded. */
  parameterCount?: number;
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
  /**
   * Whether the chat template declares a thinking mode. `null` when llama.cpp
   * reported no template, which means unknown rather than "cannot think".
   */
  canReason: boolean | null;
  defaultGenerationSettings?: unknown;
  raw: unknown;
};

export type LlamaTokenizeResult = {
  tokens: number;
  raw: unknown;
};

export type LlamaAbortVerificationResult = {
  checked: boolean;
  idle: boolean;
  warning?: NelleError;
};

export type AbortConversationResult = {
  aborted: boolean;
  warning?: NelleError;
};

export type ModelParams = {
  /**
   * The context cap the user configured, through `c` in this model's section or
   * in `[*]`. Absent means "no cap": llama.cpp uses the model's trained window.
   *
   * It is a *prediction* of what llama.cpp will do. Once the model has loaded,
   * `/props` is the truth -- see `effectiveContextWindow`.
   */
  contextSize?: number;
  gpuLayers?: number;
  threads?: number;
  batchSize?: number;
  extra?: Record<string, string>;
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
  /** From Hugging Face's own parsed GGUF header, on the request Nelle already sends. */
  architecture?: string;
  parameterCount?: number;
  /** `gguf.context_length`: the trained window, known before the first load. */
  contextTrain?: number;
  files: HuggingFaceFile[];
  quants: HuggingFaceQuant[];
};

export type {
  ChatMessage,
  ChatPerformance,
  ChatPerformanceMetric,
  ChatRole,
  ChatStreamEvent,
  ToolCallEvent,
};

export type AppState = {
  version: 1;
  activeModelId: string | null;
  models: ConfiguredModel[];
  globalModelParams: Record<string, string>;
  reasoning: ReasoningSettings;
  runtime: {
    host: string;
    port: number;
    modelsMax: number;
    sleepIdleSeconds: number;
  };
  chat: ChatMessage[];
};
