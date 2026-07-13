import {z} from 'zod';

import {
  chatAttachmentReferenceSchema,
  chatRequestSchema,
  devicesResponseSchema,
  deviceViewSchema,
  hostToolsResponseSchema,
  issuedTokensSchema,
  nelleErrorSchema,
  nelleWarningSchema,
  pairingCodeResponseSchema,
  pairingPayloadSchema,
  pairRequestSchema,
  preferencesSchema,
  refreshRequestSchema,
  uploadResponseSchema,
} from '../../../packages/shared/src/contracts.ts';
import {AUTH_ALLOWLIST, LOOPBACK_ONLY_PATHS} from './auth';
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
import {
  huggingFaceFileSchema,
  huggingFaceModelResultSchema,
  huggingFaceQuantSchema,
  huggingFaceSearchResponseSchema,
} from '../../../packages/shared/src/huggingfaceSearch.ts';
import {
  llamaModelsResponseSchema,
  llamaRouterModelSchema,
} from '../../../packages/shared/src/llamaModels.ts';
import {
  configuredModelSchema,
  deleteModelResponseSchema,
  invalidModelParamSchema,
  invalidModelParamsResponseSchema,
  modelCatalogSchema,
  modelParamsSchema,
} from '../../../packages/shared/src/modelCatalog.ts';
import {
  llamaOptionCatalogueSchema,
  llamaOptionSchema,
  llamaRouterPropsSchema,
  llamaTokenizeResultSchema,
  runtimeInstallEventSchema,
  runtimeLogTailSchema,
  runtimeStatusSchema,
} from '../../../packages/shared/src/runtime.ts';
import {conversationMessageSchema} from '../../../packages/shared/src/messages.ts';
import {reasoningLevelSchema} from '../../../packages/shared/src/reasoning.ts';
import {
  settingsFieldSchema,
  settingsSchemaResponseSchema,
  settingsSectionSchema,
} from '../../../packages/shared/src/settings.ts';

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
  // Registered by name so `ChatRequest.attachments` $refs it instead of inlining it:
  // an inlined object codegens as an anonymous `Attachments` class, which is not a name
  // anyone can reason about. `ChatAttachmentInput` is deliberately NOT here -- it is the
  // server's post-resolution type (it carries `text`/`data`), a client never sends it,
  // and serving it only invites one to try.
  ['ChatAttachmentReference', chatAttachmentReferenceSchema],
  ['UploadResponse', uploadResponseSchema],
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
  // llama.cpp's live model view, so the client codegens the model selector's DTOs.
  ['LlamaRouterModel', llamaRouterModelSchema],
  ['LlamaModelsResponse', llamaModelsResponseSchema],
  // Device pairing + auth. Served for the same reason as everything else here: a
  // second client should codegen these, not reverse-engineer them from a 401.
  ['PairingPayload', pairingPayloadSchema],
  ['PairingCodeResponse', pairingCodeResponseSchema],
  ['PairRequest', pairRequestSchema],
  ['RefreshRequest', refreshRequestSchema],
  ['IssuedTokens', issuedTokensSchema],
  ['DeviceView', deviceViewSchema],
  ['DevicesResponse', devicesResponseSchema],
  // The settings schema's own shape. Without it, the one contract designed to be
  // rendered generically is the only one a client cannot codegen -- and the Flutter
  // client hand-rolled a class to parse it, which is precisely the copy-of-the-copy
  // that serving a schema exists to prevent.
  ['HostToolsResponse', hostToolsResponseSchema],
  ['SettingsField', settingsFieldSchema],
  ['SettingsSection', settingsSectionSchema],
  ['SettingsSchema', settingsSchemaResponseSchema],
  // Runtime + model administration. Twenty-six routes ran without a single one of their
  // shapes in the contract, so the only client that had them was the browser, which
  // hand-declared every one. `RuntimeStatus` is the anchor: `GET /api/runtime` serves it
  // and `GET /api/llama/props` embeds it.
  ['RuntimeStatus', runtimeStatusSchema],
  ['LlamaRouterProps', llamaRouterPropsSchema],
  ['RuntimeLogTail', runtimeLogTailSchema],
  // Installing llama.cpp is a *build*, so it is narrated rather than awaited. A client that
  // could not codegen these would have to parse the one stream that matters most when it
  // goes wrong.
  ['RuntimeInstallEvent', runtimeInstallEventSchema],
  ['LlamaTokenizeResult', llamaTokenizeResultSchema],
  // What a `models.ini` key is validated against -- which is llama-server's own `--help`,
  // never a list Nelle carries. A client renders it for completion; it must not validate.
  ['LlamaOption', llamaOptionSchema],
  ['LlamaOptionCatalogue', llamaOptionCatalogueSchema],
  ['ModelParams', modelParamsSchema],
  ['ConfiguredModel', configuredModelSchema],
  ['ModelCatalog', modelCatalogSchema],
  // Deleting a model can now reclaim its weights -- and must never destroy a sibling's, since
  // a Hugging Face repo directory holds every quant of that repo.
  ['DeleteModelResponse', deleteModelResponseSchema],
  // The 400 that a bad params save answers with. It names *every* offending key, so a
  // client can mark the rows rather than print one line of red text under a form of ten.
  ['InvalidModelParam', invalidModelParamSchema],
  ['InvalidModelParamsResponse', invalidModelParamsResponseSchema],
  ['HuggingFaceFile', huggingFaceFileSchema],
  ['HuggingFaceQuant', huggingFaceQuantSchema],
  ['HuggingFaceModelResult', huggingFaceModelResultSchema],
  ['HuggingFaceSearchResponse', huggingFaceSearchResponseSchema],
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
    // The allowlisted routes are how a device *gets* a token, so declaring that they
    // need one describes a lock whose key is inside it. A generated client would send
    // an Authorization header it cannot yet have, or -- worse -- conclude it cannot
    // pair at all.
    const security = AUTH_ALLOWLIST.has(path) ? [] : [{bearerAuth: []}];
    item[method.toLowerCase()] = {
      summary: `${method} ${path}`,
      ...(LOOPBACK_ONLY_PATHS.has(path)
        ? {
            description:
              'Loopback only. Answers 404 to an authenticated LAN device, so a paired device cannot enrol another or enumerate its siblings.',
          }
        : {}),
      security,
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
