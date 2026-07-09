import type {
  AttachmentMetadata,
  ConversationContextUsage,
  ConversationSnapshot,
} from '../../../packages/shared/src/conversations.ts';
import type {RunKind, TerminalRunStatus} from '../../../packages/shared/src/conversations.ts';
import type {
  ChatAttachmentInput,
  NelleError,
  NelleWarning,
} from '../../../packages/shared/src/contracts.ts';
import type {ReasoningSettings} from '../../../packages/shared/src/reasoning.ts';

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
  contextSize: number;
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
  files: HuggingFaceFile[];
  quants: HuggingFaceQuant[];
};

export type ChatRole = 'user' | 'assistant' | 'system';

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  attachments?: AttachmentMetadata[];
  modelId?: string;
  modelRuntimeId?: string;
  modelAliasSnapshot?: string;
  regeneratesPiEntryId?: string;
  displayGroupId?: string;
  performance?: ChatPerformance;
  toolCalls?: ToolCallEvent[];
  /** Thinking text llama.cpp streamed as `reasoning_content`. */
  reasoning?: string;
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
  /**
   * Legacy generation throughput field. Kept so older persisted messages
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
  | {
      type: 'run.started';
      runId: string;
      conversationId: string;
      kind: RunKind;
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
      status: TerminalRunStatus;
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
      /** The server is making the requested model runnable before the run starts. */
      type: 'model.loading';
      conversationId: string;
      modelId: string;
      status: string;
      progress?: number;
      createdAt: string;
    }
  | {type: 'message.user.created'; message: ChatMessage}
  | {type: 'message.assistant.started'; message: ChatMessage; harness: 'pi' | 'llamacpp'}
  | {type: 'message.assistant.delta'; id: string; delta: string}
  | {type: 'message.assistant.reasoning_delta'; id: string; delta: string}
  | {type: 'message.assistant.completed'; message: ChatMessage}
  | {type: 'performance.updated'; id: string; performance: ChatPerformance}
  | {type: 'tool_call.updated'; call: ToolCallEvent}
  | {
      type: 'conversation.updated';
      conversationId: string;
      title?: string;
      titleSource?: ConversationSnapshot['conversation']['titleSource'];
      activeLeafPiEntryId?: string;
      updatedAt: string;
    }
  // `conversation.forked` is specified by the router plan but has no channel to
  // travel on: fork and clone are plain JSON routes, and Nelle exposes no
  // conversation-level SSE stream, only per-run ones. Adding the union member
  // without an emitter would just be a type nobody sends. It belongs with the
  // conversation event stream a mobile client will need.
  | ({type: 'run.warning'} & NelleWarning)
  | ({type: 'error'} & NelleError);

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
