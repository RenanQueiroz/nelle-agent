import type {z} from 'zod';

import type {ChatAttachmentInput, NelleError} from './contracts/contracts.ts';
import type {
  huggingFaceFileSchema,
  huggingFaceQuantSchema,
  HuggingFaceModelResultContract,
} from './contracts/huggingfaceSearch.ts';
import type {LlamaRouterModelContract} from './contracts/llamaModels.ts';
import type {ConfiguredModelContract, ModelParamsContract} from './contracts/modelCatalog.ts';
import type {
  LlamaRouterPropsContract,
  LlamaTokenizeResultContract,
  RuntimeStatusContract,
} from './contracts/runtime.ts';
import type {
  ChatMessage,
  ChatPerformance,
  ChatPerformanceMetric,
  ChatRole,
  ChatStreamEvent,
  ToolCallEvent,
} from './contracts/streamEvents.ts';

export type {ChatAttachmentInput};

export type RuntimeInstallMode = 'source-master' | 'github-release' | 'external';

/**
 * Derived from the published contract, so the wire payload cannot drift from what the
 * OpenAPI promises without a compile error -- the same move as `LlamaRouterModel`.
 */
export type RuntimeStatus = RuntimeStatusContract;

/** The contract plus `raw`, llama.cpp's opaque blob, which the contract does not promise. */
export type LlamaRouterProps = LlamaRouterPropsContract & {raw?: unknown};

/**
 * The published contract (`llamaRouterModelSchema`, which the served OpenAPI carries
 * and the Flutter client codegens) plus `raw` -- llama.cpp's opaque blob, which the
 * server keeps and the contract deliberately does not promise. Deriving the type from
 * the schema means the wire payload cannot drift from the contract without a compile
 * error.
 */
export type LlamaRouterModel = LlamaRouterModelContract & {raw?: unknown};

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

/** The contract plus `raw`, llama.cpp's blob, which the contract does not promise. */
export type LlamaTokenizeResult = LlamaTokenizeResultContract & {raw?: unknown};

export type LlamaAbortVerificationResult = {
  checked: boolean;
  idle: boolean;
  warning?: NelleError;
};

export type AbortConversationResult = {
  aborted: boolean;
  warning?: NelleError;
};

/**
 * `gpuLayers`, `threads` and `batchSize` used to live here and were **dead**: nothing ever
 * populated them (the read path builds params from `extra` alone) and nothing read them,
 * so they were always absent -- a promise the contract made and never kept. They are gone.
 * A GPU-offload or thread setting is just a key in `extra`, like every other llama.cpp
 * lever, because Nelle does not police how a model is loaded.
 */
export type ModelParams = ModelParamsContract;

export type ConfiguredModel = ConfiguredModelContract;

export type HuggingFaceFile = z.infer<typeof huggingFaceFileSchema>;
export type HuggingFaceQuant = z.infer<typeof huggingFaceQuantSchema>;
export type HuggingFaceModelResult = HuggingFaceModelResultContract;

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
  runtime: {
    host: string;
    port: number;
  };
  chat: ChatMessage[];
};
