import {z} from 'zod';

import {
  chatAttachmentInputSchema,
  chatRequestSchema,
  nelleErrorSchema,
  nelleWarningSchema,
  preferencesSchema,
} from '../../../packages/shared/src/contracts.ts';
import {
  chatMessageSchema,
  chatPerformanceSchema,
  chatStreamEventSchema,
  toolCallEventSchema,
} from '../../../packages/shared/src/streamEvents.ts';
import {
  activeRunStatusSchema,
  attachmentMetadataSchema,
  conversationContextUsageSchema,
  conversationEntryProjectionSchema,
  conversationListItemSchema,
  conversationListResponseSchema,
  conversationSnapshotSchema,
  conversationStatusSchema,
  modelListItemSchema,
} from '../../../packages/shared/src/conversations.ts';
import {conversationMessageSchema} from '../../../packages/shared/src/messages.ts';
import {reasoningLevelSchema} from '../../../packages/shared/src/reasoning.ts';

/**
 * Builds the OpenAPI 3.1 document from the zod contract schemas and the router's
 * live route list, so a Dart (or any) client codegens typed models from one
 * source. zod 4's `z.toJSONSchema` emits JSON Schema 2020-12, which is what
 * OpenAPI 3.1 uses -- no third-party dependency. See plans/nelle-pre-flutter-prep.md.
 */

const CONTRACT_SCHEMAS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['NelleError', nelleErrorSchema],
  ['NelleWarning', nelleWarningSchema],
  ['ChatMessage', chatMessageSchema],
  ['ChatPerformance', chatPerformanceSchema],
  ['ToolCallEvent', toolCallEventSchema],
  ['ChatStreamEvent', chatStreamEventSchema],
  ['ChatRequest', chatRequestSchema],
  ['ChatAttachmentInput', chatAttachmentInputSchema],
  ['Preferences', preferencesSchema],
  // Conversation list + snapshot DTOs, so the Flutter client codegens them.
  ['ConversationListItem', conversationListItemSchema],
  ['ConversationListResponse', conversationListResponseSchema],
  ['ConversationSnapshot', conversationSnapshotSchema],
  ['ConversationMessage', conversationMessageSchema],
  ['ConversationEntryProjection', conversationEntryProjectionSchema],
  ['ConversationContextUsage', conversationContextUsageSchema],
  ['ConversationStatus', conversationStatusSchema],
  ['ActiveRunStatus', activeRunStatusSchema],
  ['ReasoningLevel', reasoningLevelSchema],
  ['ModelListItem', modelListItemSchema],
  ['AttachmentMetadata', attachmentMetadataSchema],
];

export function buildOpenApiDocument(
  routes: ReadonlyArray<{method: string; path: string}>,
): object {
  const registry = z.registry<{id: string}>();
  for (const [id, schema] of CONTRACT_SCHEMAS) {
    registry.add(schema, {id});
  }
  const {schemas} = z.toJSONSchema(registry, {
    uri: id => `#/components/schemas/${id}`,
  }) as {schemas: Record<string, Record<string, unknown>>};
  // `$schema`/`$id` are JSON-Schema envelope keys, not OpenAPI component keys.
  for (const schema of Object.values(schemas)) {
    delete schema.$schema;
    delete schema.$id;
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const {method, path} of routes) {
    const openApiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const item = paths[openApiPath] ?? (paths[openApiPath] = {});
    item[method.toLowerCase()] = {
      summary: `${method} ${path}`,
      security: [{bearerAuth: []}],
      responses: {
        '200': {description: 'Success'},
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {error: {$ref: '#/components/schemas/NelleError'}},
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Nelle Agent API',
      version: '1.0.0',
      description: 'Local-first AI agent server. Generated from zod contracts.',
    },
    components: {
      schemas,
      securitySchemes: {bearerAuth: {type: 'http', scheme: 'bearer'}},
    },
    security: [{bearerAuth: []}],
    paths,
  };
}
