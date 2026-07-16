import {z} from 'zod';

import {attachmentMetadataSchema} from './attachmentMetadata.ts';
import {nelleErrorSchema, nelleWarningSchema} from './contracts.ts';
import {
  conversationContextUsageSchema,
  runKindSchema,
  terminalRunStatusSchema,
} from './conversations.ts';

/**
 * The chat/stream wire contract, zod-first so it is one source of truth for the
 * server and the served OpenAPI (which a Dart client codegens from). The event
 * `type` values are the wire contract; see AGENTS.md.
 */

export const chatRoleSchema = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatPerformanceMetricSchema = z.object({
  tokens: z.number(),
  /** Absent when the burst was too short for llama.cpp to time it. */
  tokensPerSecond: z.number().optional(),
  milliseconds: z.number().optional(),
  totalTokens: z.number().optional(),
  cacheTokens: z.number().optional(),
});
export type ChatPerformanceMetric = z.infer<typeof chatPerformanceMetricSchema>;

export const chatPerformanceSchema = z.object({
  source: z.enum(['llamacpp-slots', 'llamacpp-timings']),
  prompt: chatPerformanceMetricSchema.optional(),
  generation: chatPerformanceMetricSchema.optional(),
  /** Legacy generation throughput, kept so older persisted messages still render. */
  tokensPerSecond: z.number().optional(),
  /** Legacy generated token count matching `tokensPerSecond`. */
  generatedTokens: z.number().optional(),
});
export type ChatPerformance = z.infer<typeof chatPerformanceSchema>;

export const toolCallEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  target: z.string().optional(),
  status: z.enum(['running', 'complete', 'error']),
  duration: z.string().optional(),
  input: z.string().optional(),
  output: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type ToolCallEvent = z.infer<typeof toolCallEventSchema>;

export const chatMessageSchema = z.object({
  id: z.string(),
  role: chatRoleSchema,
  content: z.string(),
  createdAt: z.string(),
  attachments: z.array(attachmentMetadataSchema).optional(),
  modelId: z.string().optional(),
  modelRuntimeId: z.string().optional(),
  modelAliasSnapshot: z.string().optional(),
  regeneratesPiEntryId: z.string().optional(),
  displayGroupId: z.string().optional(),
  performance: chatPerformanceSchema.optional(),
  toolCalls: z.array(toolCallEventSchema).optional(),
  /** Thinking text llama.cpp streamed as `reasoning_content`. */
  reasoning: z.string().optional(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

const runErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
});
const titleSourceSchema = z.enum(['generated', 'user', 'imported', 'fallback']);

export const chatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    runId: z.string(),
    conversationId: z.string(),
    kind: runKindSchema,
    modelId: z.string().optional(),
    status: z.enum(['pending', 'running']),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('run.aborted'),
    runId: z.string(),
    conversationId: z.string(),
    reason: z.enum(['user', 'server', 'runtime']),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('run.completed'),
    runId: z.string(),
    conversationId: z.string(),
    status: terminalRunStatusSchema,
    error: runErrorSchema.optional(),
    createdAt: z.string(),
  }),
  conversationContextUsageSchema.extend({
    type: z.literal('context.updated'),
    conversationId: z.string(),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('compact.started'),
    runId: z.string(),
    conversationId: z.string(),
    instructions: z.string().optional(),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('compact.completed'),
    runId: z.string(),
    conversationId: z.string(),
    compacted: z.boolean(),
    tokensBefore: z.number().optional(),
    firstKeptEntryId: z.string().optional(),
    summaryPreview: z.string().optional(),
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('compact.failed'),
    runId: z.string(),
    conversationId: z.string(),
    error: runErrorSchema,
    createdAt: z.string(),
  }),
  z.object({
    type: z.literal('model.loading'),
    conversationId: z.string(),
    modelId: z.string(),
    status: z.string(),
    /** 0..1 of the current phase; absent means "working, amount unknown", never zero. */
    progress: z.number().optional(),
    /**
     * `downloading` while the weights are still arriving (a first load downloads multi-GB
     * blobs), `loading` once llama.cpp is reading them in. Absent on the first quiet ticks,
     * when there is no evidence of either yet — a client keeps its plain placeholder.
     */
    phase: z.enum(['downloading', 'loading']).optional(),
    /** Bytes on the wire so far. On routers that emit no download SSE this is the repo
     *  directory measured on disk, so it exists even when `totalBytes` does not. */
    downloadedBytes: z.number().optional(),
    totalBytes: z.number().optional(),
    createdAt: z.string(),
  }),
  z.object({type: z.literal('message.user.created'), message: chatMessageSchema}),
  z.object({
    type: z.literal('message.assistant.started'),
    message: chatMessageSchema,
    harness: z.enum(['pi', 'llamacpp']),
  }),
  z.object({
    type: z.literal('message.assistant.delta'),
    id: z.string(),
    delta: z.string(),
    isReasoning: z.literal(false),
  }),
  z.object({
    type: z.literal('message.assistant.reasoning_delta'),
    id: z.string(),
    delta: z.string(),
    isReasoning: z.literal(true),
  }),
  z.object({type: z.literal('message.assistant.completed'), message: chatMessageSchema}),
  z.object({
    type: z.literal('performance.updated'),
    id: z.string(),
    performance: chatPerformanceSchema,
  }),
  z.object({type: z.literal('tool_call.updated'), call: toolCallEventSchema}),
  z.object({
    type: z.literal('conversation.updated'),
    conversationId: z.string(),
    title: z.string().optional(),
    titleSource: titleSourceSchema.optional(),
    activeLeafPiEntryId: z.string().optional(),
    updatedAt: z.string(),
  }),
  nelleWarningSchema.extend({type: z.literal('run.warning')}),
  nelleErrorSchema.extend({type: z.literal('error')}),
]);
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
