import path from 'node:path';
import fs from 'node:fs/promises';

import {z} from 'zod';

import {reasoningLevelSchema} from '../../../packages/shared/src/reasoning.ts';
import {HuggingFaceService} from './huggingface';
import {LlamaCppManager} from './llamacpp';
import {registerLlamaProxy} from './llamaProxy';
import {PiHarness, isConversationNotFoundError} from './piHarness';
import {streamDirectLlama} from './directLlama';
import {createErrorEvent, normalizeNelleError} from './errors';
import {Router, applyCors, createStaticHandler, json, preflightResponse, type Ctx} from './http';
import {AppStore} from './store';
import {AppDatabase} from './database';
import {exportConversationArchive, importConversationArchive} from './conversationArchive';
import {HostToolRepository} from './hostTools';
import {PreferencesRepository} from './preferences';
import {SettingsRepository} from './settings';
import {UPLOAD_SWEEP_INTERVAL_MS, UploadRepository} from './uploads';
import {DeviceRepository} from './devices';
import {AUTH_ALLOWLIST, authorizeBearer} from './auth';
import {buildPairingPayload} from './pairing';
import {ensureServerCert, localIPv4s, type ServerCert} from './tls';
import {buildOpenApiDocument} from './openapi';
import {ingestUpload, resolveChatAttachments, UnsupportedAttachmentError} from './attachmentIngest';
import {ATTACHMENT_LIMITS} from '../../../packages/shared/src/attachments.ts';
import {ModelCacheRepository} from './modelCache';
import {GgufMetadataRepository} from './ggufMetadata';
import {recordModelProps} from './modelProps';
import {effectiveContextWindow} from './contextWindow';
import {
  ConversationRepository,
  LEGACY_DEFAULT_CONVERSATION_ID,
  type ConversationDeleteResources,
} from './conversations';
import {resolveConversationModel} from './conversationModel';
import type {AppPaths} from './paths';
import type {ChatAttachmentInput, ChatStreamEvent} from './types';
import type {NelleError, UploadResponse} from '../../../packages/shared/src/contracts.ts';
import {
  chatRequestSchema,
  createEventEnvelope,
  pairRequestSchema,
  preferencesSchema,
  refreshRequestSchema,
  serializeSseEnvelope,
  NELLE_ERROR_CODES,
} from '../../../packages/shared/src/contracts.ts';
import {
  SLASH_COMMAND_REGISTRY,
  unsupportedSlashCommandMessage,
} from '../../../packages/shared/src/commands.ts';
import {
  SETTINGS_REGISTRY,
  settingsPatchSchema,
  type SettingsGroup,
  type SettingsValues,
} from '../../../packages/shared/src/settings.ts';
import {
  ALLOW_LAN_ACCESS_KEY,
  ATTACHMENTS_SETTINGS_SLUG,
  MAX_IMAGE_MEGAPIXELS_KEY,
  NETWORK_SETTINGS_SLUG,
  SESSION_RESETTING_SETTINGS_SLUGS,
} from '../../../packages/shared/src/settingsKeys.ts';
import {
  invalidModelParamsCode,
  invalidModelParamsMessage,
  validateModelParams,
  type InvalidModelParam,
} from '../../../packages/shared/src/modelParams.ts';
import {LlamaOptionCatalogueCache} from './llamaParams';

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

const editableParamsSchema = z.record(z.string(), z.string());

const updateGlobalModelParamsSchema = z.object({
  params: editableParamsSchema,
});

const tokenizeSchema = z.object({
  content: z.string().max(200_000),
  addSpecial: z.boolean().optional(),
  parseSpecial: z.boolean().optional(),
  withPieces: z.boolean().optional(),
});

const updateModelSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  params: editableParamsSchema.optional(),
});

const compactConversationSchema = z
  .object({
    instructions: z.string().max(2000).optional(),
  })
  .optional();

const regenerateMessageSchema = z
  .object({
    modelId: z.string().min(1).optional(),
  })
  .optional();

const forkConversationSchema = z.object({
  entryId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
});

const cloneConversationSchema = z
  .object({
    entryId: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .optional();

const listConversationsQuerySchema = z.object({
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});

const createConversationSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    defaultModelId: z.string().nullable().optional(),
  })
  .optional();

const patchConversationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  pinned: z.boolean().optional(),
  defaultModelId: z.string().nullable().optional(),
});

const conversationReasoningSchema = z.object({level: reasoningLevelSchema});

const hostToolSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
});

export type NelleServer = {
  handle: (req: Request, opts: {trusted: boolean}) => Promise<Response>;
  close: () => Promise<void>;
  /** Whether the "allow LAN access" setting is on (read at construction). */
  lanAccessEnabled: boolean;
  /** The self-signed TLS cert for the LAN listener, or `null` when LAN is off. */
  serverCert: ServerCert | null;
};

export async function createServer(
  paths: AppPaths,
  // The registry is injectable so the settings machinery can be tested against a
  // fixture registry, which is the only way to cover it while the real one is
  // still empty.
  options: {settingsRegistry?: readonly SettingsGroup[]} = {},
): Promise<NelleServer> {
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const conversations = new ConversationRepository(database);
  await conversations.init();
  const hostTools = new HostToolRepository(database);
  const preferences = new PreferencesRepository(database);
  const settings = new SettingsRepository(database, options.settingsRegistry ?? SETTINGS_REGISTRY);
  const modelCache = new ModelCacheRepository(database);
  const ggufMetadata = new GgufMetadataRepository(database);
  const uploads = new UploadRepository(database, paths);
  const devices = new DeviceRepository(database);
  const lanAccessEnabled =
    settings.tryGetGroup(NETWORK_SETTINGS_SLUG)?.[ALLOW_LAN_ACCESS_KEY] === true;
  const tlsPort = Number(process.env.NELLE_TLS_PORT ?? 8788);
  // Generated once and kept stable so a paired device's pinned fingerprint holds.
  const serverCert = lanAccessEnabled ? await ensureServerCert(paths) : null;
  const llama = new LlamaCppManager(paths, store, settings);
  const llamaOptions = new LlamaOptionCatalogueCache(() => llama.getServerBinaryPath());
  const hf = new HuggingFaceService(store);
  const pi = new PiHarness(paths, store, conversations, hostTools, llama, modelCache, settings);
  conversations.syncLegacyDefaultConversationFromState(await store.getState());
  await pi.migrateLegacyDefaultConversation();
  await conversations.markInvalidPiSessionsUnavailable();
  const attachmentSweep = await sweepOrphanAttachmentFiles(
    paths,
    conversations.getReferencedAttachmentStoragePaths(),
  );
  // Draft uploads nobody sent are garbage after their TTL, and a crash between
  // `mkdir` and `INSERT` leaves a directory no row points at.
  const uploadSweep = {
    ...(await uploads.sweepExpired()),
    orphanDirectories: (await uploads.sweepOrphanDirectories()).deleted,
  };

  const log = createLogger();
  if (attachmentSweep.deleted > 0 || attachmentSweep.failed.length > 0) {
    log.info({attachmentSweep}, 'completed orphan attachment sweep');
  }
  if (uploadSweep.deleted > 0 || uploadSweep.orphanDirectories > 0) {
    log.info({uploadSweep}, 'completed expired upload sweep');
  }
  const uploadSweepTimer = setInterval(() => {
    void uploads
      .sweepExpired()
      .then(result => {
        if (result.deleted > 0) {
          log.info({uploadSweep: result}, 'swept expired uploads');
        }
        return result;
      })
      .catch(error => {
        log.warn({error}, 'expired upload sweep failed');
      });
  }, UPLOAD_SWEEP_INTERVAL_MS);
  // A timer that keeps the process alive would hang `bun test`.
  uploadSweepTimer.unref();

  const router = new Router();
  registerLlamaProxy(router, store);

  router.get('/api/health', async () =>
    json({
      ok: true,
      app: 'nelle-server',
      dataDir: paths.dataDir,
      runtime: await llama.getStatus(),
    }),
  );

  // The composer's typeahead and its refusal copy come from here, so
  // allowlisting a command ships without touching a client.
  router.get('/api/commands', async () =>
    json({
      commands: SLASH_COMMAND_REGISTRY.commands,
      unsupported: SLASH_COMMAND_REGISTRY.unsupported,
    }),
  );

  router.get('/api/state', async () =>
    json({
      state: await store.getState(),
      runtime: await llama.getStatus(),
      hostTools: hostTools.getSettings(),
    }),
  );

  router.get('/api/settings/host-tools', async () => json({hostTools: hostTools.getSettings()}));

  // Favorites follow the user, not the browser profile that set them.
  router.get('/api/settings/preferences', async () => {
    const state = await store.getState();
    return json(preferences.getPreferences(state.models.map(model => model.id)));
  });

  router.patch('/api/settings/preferences', async ctx => {
    const body = preferencesSchema.parse(await ctx.body());
    const saved = preferences.updatePreferences(body);
    const state = await store.getState();
    const known = new Set(state.models.map(model => model.id));
    return json({...saved, favoriteModelIds: saved.favoriteModelIds.filter(id => known.has(id))});
  });

  // The settings schema is served for the same reason the slash-command registry
  // is: a second client renders the fields without carrying a copy of fifteen
  // labels, and a new setting ships without a client release.
  router.get('/api/settings/schema', async () => json({sections: settings.groups}));

  // One route pair per registry group. Registering them from the registry rather
  // than behind a `/api/settings/:group` parameter keeps `schema`, `preferences`
  // and `host-tools` from being swallowed by it, and makes a slug collision a
  // loud failure at boot instead of a route that silently never matches.
  for (const group of settings.groups) {
    const patchSchema = settingsPatchSchema(group);
    // Pi bakes the system prompt into a session at construction, so a change to
    // the custom instructions reaches an open conversation only if the session it
    // would reuse is thrown away. `PATCH /api/settings/host-tools` already does
    // exactly this, for exactly the same reason.
    const resetsSessions = SESSION_RESETTING_SETTINGS_SLUGS.includes(group.slug);
    router.get(`/api/settings/${group.slug}`, async () => json(settings.getGroup(group.slug)));
    router.patch(`/api/settings/${group.slug}`, async ctx => {
      const body = patchSchema.parse(await ctx.body()) as SettingsValues;
      const saved = settings.updateGroup(group.slug, body);
      if (resetsSessions) {
        pi.resetSession();
      }
      return json(saved);
    });
  }

  router.patch('/api/settings/host-tools', async ctx => {
    const body = hostToolSettingsSchema.parse(await ctx.body());
    let hostToolSettings;
    try {
      hostToolSettings = hostTools.updateSettings(body);
    } catch (error) {
      return json(
        {
          error: {
            code: 'host_tools_acknowledgement_required',
            message:
              error instanceof Error
                ? error.message
                : 'Host tools must be acknowledged before they can be enabled.',
          },
        },
        400,
      );
    }
    pi.resetSession();
    return json({hostTools: hostToolSettings});
  });

  router.get('/api/runtime', async ctx => {
    const checkLatest = ctx.query.latest === '1';
    return json(await llama.getStatus(checkLatest));
  });

  router.post('/api/runtime/install', async () => json(await llama.installOrUpdate()));
  router.post('/api/runtime/update', async () => json(await llama.installOrUpdate()));
  router.post('/api/runtime/start', async () => json(await llama.start()));
  router.post('/api/runtime/stop', async () => json(await llama.stop()));
  router.get('/api/runtime/logs', async ctx => {
    const requestedBytes = Number(ctx.query.maxBytes ?? 80_000);
    const maxBytes = Number.isFinite(requestedBytes)
      ? Math.min(Math.max(0, requestedBytes), 1_000_000)
      : 80_000;
    return json(await llama.readLogTail(maxBytes));
  });
  router.get('/api/llama/props', async () => handleLlamaRoute(() => llama.getRouterProps()));

  router.get('/api/llama/models', async () =>
    handleLlamaRoute(async () => {
      const result = await llama.getRouterModels();
      modelCache.upsertRouterModels(result.models);
      // Both windows, so a client renders "Full window: 262,144 · running at
      // 16,384" without re-deriving either from `raw`. `contextWindow` is
      // llama.cpp's `/props` answer and `contextTrain` its `n_ctx_train`; both
      // are `undefined` until the model has been loaded once.
      return {
        ...result,
        models: result.models.map(model => {
          const cached = modelCache.getModel(model.sectionId);
          // The router only reports `n_ctx_train` for a model it has loaded. The
          // GGUF header knows it without the network, and without a load.
          const parsed = cached?.modelOid ? ggufMetadata.get(cached.modelOid) : null;
          return {
            ...model,
            contextWindow: cached?.contextWindow,
            contextTrain: cached?.contextTrain ?? parsed?.contextTrain,
            architecture: model.architecture ?? parsed?.architecture,
            parameterCount: parsed?.parameterCount,
          };
        }),
      };
    }),
  );

  router.post('/api/llama/models/reload', async () =>
    handleLlamaRoute(async () => {
      const result = await llama.getRouterModels({reload: true});
      modelCache.upsertRouterModels(result.models);
      return result;
    }),
  );

  router.get('/api/llama/models/events', async ctx => {
    let upstream: Response;
    try {
      // `ctx.req.signal` aborts when the client drops, aborting the upstream fetch.
      upstream = await llama.fetchRouterStream('/models/sse', ctx.req.signal);
    } catch (error) {
      return llamaError(error);
    }
    if (!upstream.ok || !upstream.body) {
      return llamaError(
        new Error(
          upstream.body
            ? `llama.cpp router events failed: ${upstream.status}`
            : 'llama.cpp router events response did not include a stream.',
        ),
      );
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
        'x-accel-buffering': 'no',
      },
    });
  });

  router.get('/api/llama/models/:id/props', async ctx => {
    const id = ctx.params.id;
    return handleLlamaRoute(async () => {
      const props = await llama.getModelProps(id);
      // A sleeping model answers /props with an error, so only a success caches.
      await recordModelProps({
        sectionId: id,
        props,
        modelCache,
        ggufMetadata,
        onError: error => log.warn({err: error, modelId: id}, 'could not parse the GGUF header'),
      });
      return props;
    });
  });

  router.post('/api/llama/tokenize', async ctx => {
    const body = tokenizeSchema.parse(await ctx.body());
    return handleLlamaRoute(() => llama.tokenize(body.content, body));
  });

  router.post('/api/llama/models/:id/load', async ctx =>
    handleLlamaRoute(() => llama.loadRouterModel(ctx.params.id), NELLE_ERROR_CODES.modelLoadFailed),
  );

  router.post('/api/llama/models/:id/unload', async ctx =>
    handleLlamaRoute(() => llama.unloadRouterModel(ctx.params.id)),
  );

  router.get('/api/models', async () => {
    const state = await store.getState();
    return json({
      models: state.models,
      activeModelId: state.activeModelId,
      globalModelParams: state.globalModelParams,
    });
  });

  router.post('/api/models/:id/activate', async ctx => {
    const model = await store.setActiveModel(ctx.params.id);
    await llama.writePreset(model);
    return json({model});
  });

  // Served so a settings UI can offer completion, and so no client carries a copy
  // of llama.cpp's argument list that goes stale on the next upgrade.
  router.get('/api/llama/params', async () => json(await llamaOptions.get()));

  router.patch('/api/models/global-params', async ctx => {
    const body = updateGlobalModelParamsSchema.parse(await ctx.body());
    const invalid = validateModelParams(body.params, {
      acceptedKeys: await llamaOptions.acceptedKeys(),
    });
    if (invalid.length > 0) {
      return json(invalidModelParamsResponse(invalid), 400);
    }
    const globalModelParams = await store.updateGlobalModelParams(body.params);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({globalModelParams});
  });

  router.patch('/api/models/:id', async ctx => {
    const id = ctx.params.id;
    const body = updateModelSchema.parse(await ctx.body());
    if (body.params) {
      const invalid = validateModelParams(body.params, {
        reservedKeys: new Set(['hf-repo', 'alias']),
        acceptedKeys: await llamaOptions.acceptedKeys(),
      });
      if (invalid.length > 0) {
        return json(invalidModelParamsResponse(invalid), 400);
      }
    }
    let model;
    try {
      model = await store.updateModel(id, body);
    } catch (error) {
      return json(
        {
          error: {
            code: 'model_not_found',
            message: error instanceof Error ? error.message : `Unknown model: ${id}`,
          },
        },
        404,
      );
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({model, state: await store.getState()});
  });

  router.post('/api/models/:id/duplicate', async ctx => {
    const id = ctx.params.id;
    let model;
    try {
      model = await store.duplicateModel(id);
    } catch (error) {
      return json(
        {
          error: {
            code: 'model_not_found',
            message: error instanceof Error ? error.message : `Unknown model: ${id}`,
          },
        },
        404,
      );
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({model, state: await store.getState()});
  });

  router.delete('/api/models/:id', async ctx => {
    const id = ctx.params.id;
    const removed = await store.removeModel(id);
    if (!removed) {
      return json({error: {code: 'model_not_found', message: `Unknown model: ${id}`}}, 404);
    }
    await llama.removeModelSection(id);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({ok: true, removedModelId: id, state: await store.getState()});
  });

  router.get('/api/huggingface/search', async ctx =>
    json({results: await hf.searchGgufModels(ctx.query.q ?? '')}),
  );

  router.post('/api/huggingface/use', async ctx => {
    const body = useHuggingFaceModelSchema.parse(await ctx.body());
    const model = await hf.useHuggingFaceGguf(body);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return json({model});
  });

  router.get('/api/conversations', async ctx => {
    const query = listConversationsQuerySchema.parse(ctx.query);
    await conversations.markInvalidPiSessionsUnavailable();
    return json(conversations.listConversations(query));
  });

  router.post('/api/conversations', async ctx => {
    const body = createConversationSchema.parse(await ctx.body()) ?? {};
    const snapshot = await pi.createConversation(body);
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.delete('/api/conversations', async () => {
    const resources = conversations.getAllConversationDeleteResources();
    conversations.hardDeleteAllConversations();
    hostTools.deleteAllAuditEvents();
    const cleanup = await deleteConversationResources(paths, resources);
    await store.clearChat();
    pi.resetSession();
    return json({ok: true, cleanup});
  });

  router.post('/api/conversations/import', async ctx => {
    const bytes = new Uint8Array(await ctx.req.arrayBuffer());
    if (bytes.length === 0) {
      return json(
        {
          error: {
            code: 'invalid_archive_upload',
            message: 'Upload a .nelle-chat.zip archive body.',
          },
        },
        400,
      );
    }
    let imported: {conversationId: string};
    try {
      imported = await importConversationArchive({paths, store, conversations, bytes});
    } catch (error) {
      return json(
        {
          error: {
            code: 'invalid_archive',
            message: error instanceof Error ? error.message : 'Archive import failed.',
          },
        },
        400,
      );
    }
    const snapshot = conversations.getSnapshot(imported.conversationId, await store.getState());
    if (!snapshot) {
      throw new Error('Imported conversation snapshot was not available.');
    }
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.get('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const snapshot = await pi.getConversationSnapshot(id);
    if (!snapshot) {
      return conversationNotFound(id);
    }
    return json({snapshot});
  });

  router.get('/api/conversations/:id/diagnostics', async ctx => {
    const id = ctx.params.id;
    const diagnostics = await conversations.getConversationDiagnostics(id);
    if (!diagnostics) {
      return conversationNotFound(id);
    }
    return json({diagnostics});
  });

  router.post('/api/conversations/:id/repair', async ctx => {
    const id = ctx.params.id;
    try {
      return json({snapshot: await pi.repairConversation(id)});
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return conversationNotFound(id);
      }
      // The session file is still unreadable. Repair never invents one.
      return json({error: normalizeNelleError(error)}, 409);
    }
  });

  router.post('/api/conversations/:id/rebuild', async ctx => {
    const id = ctx.params.id;
    try {
      return json({snapshot: await pi.rebuildConversationFromProjection(id)});
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return conversationNotFound(id);
      }
      return json({error: normalizeNelleError(error)}, 500);
    }
  });

  router.patch('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const body = patchConversationSchema.parse(await ctx.body());
    const conversation = conversations.patchConversation(id, body);
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation, snapshot: conversations.getSnapshot(id, await store.getState())});
  });

  router.put('/api/conversations/:id/reasoning', async ctx => {
    const id = ctx.params.id;
    const body = conversationReasoningSchema.parse(await ctx.body());
    const conversation = conversations.setReasoningLevel(id, body.level);
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation, snapshot: conversations.getSnapshot(id, await store.getState())});
  });

  router.post('/api/conversations/:id/pin', async ctx => {
    const id = ctx.params.id;
    const conversation = conversations.patchConversation(id, {pinned: true});
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation});
  });

  router.post('/api/conversations/:id/unpin', async ctx => {
    const id = ctx.params.id;
    const conversation = conversations.patchConversation(id, {pinned: false});
    if (!conversation) {
      return conversationNotFound(id);
    }
    return json({conversation});
  });

  router.delete('/api/conversations/:id', async ctx => {
    const id = ctx.params.id;
    const resources = conversations.getConversationDeleteResources(id);
    if (!resources) {
      return conversationNotFound(id);
    }
    if (!conversations.hardDeleteConversation(id)) {
      return conversationNotFound(id);
    }
    pi.resetSession(id);
    if (id === LEGACY_DEFAULT_CONVERSATION_ID) {
      await store.clearChat();
    }
    const cleanup = await deleteConversationResources(paths, resources);
    // Uploads the conversation owned, sent or not, go with it.
    await uploads.deleteForConversation(id);
    return json({ok: true, cleanup});
  });

  router.post('/api/conversations/:id/export', async ctx => {
    const id = ctx.params.id;
    const archive = await exportConversationArchive({
      paths,
      store,
      conversations,
      hostTools,
      conversationId: id,
    });
    if (!archive) {
      return conversationNotFound(id);
    }
    // `Uint8Array` is a valid body; the cast sidesteps the `ArrayBufferLike`
    // generic mismatch between the DOM and Node `BodyInit` type definitions.
    return new Response(archive.bytes as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${archive.filename.replace(/"/g, '')}"`,
      },
    });
  });

  router.delete('/api/conversations/:id/messages', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    pi.resetSession(id);
    conversations.clearConversationProjection(id);
    hostTools.deleteAuditEventsForConversation(id);
    if (id === LEGACY_DEFAULT_CONVERSATION_ID) {
      await store.clearChat();
    }
    return json({ok: true});
  });

  router.post('/api/conversations/:id/abort', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const result = await pi.abortConversation(id);
    return json({
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/runs/:runId/abort', async ctx => {
    const {id, runId} = ctx.params;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const result = await pi.abortConversationRun(id, runId);
    return json({
      ok: true,
      ...result,
      runId,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/compact', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = compactConversationSchema.parse(await ctx.body()) ?? {};
    const result = await pi.compactConversation(id, body.instructions);
    return json({
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/compact/stream', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = compactConversationSchema.parse(await ctx.body()) ?? {};
    return sseResponse(async sink => {
      try {
        if (process.env.NELLE_PI_DISABLED === '1') {
          throw new Error('Compaction requires the Pi harness.');
        }
        const stream = await pi.streamCompactConversation(id, body.instructions);
        await writeChatStream(sink, stream, id);
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });

  router.post('/api/conversations/:id/compact/abort', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const aborted = pi.abortCompaction(id);
    return json({
      ok: true,
      aborted,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    });
  });

  router.post('/api/conversations/:id/fork', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = forkConversationSchema.parse(await ctx.body());
    const snapshot = await pi.forkConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.post('/api/conversations/:id/clone', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = cloneConversationSchema.parse(await ctx.body()) ?? {};
    const snapshot = await pi.cloneConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return json({conversation: snapshot.conversation, snapshot});
  });

  router.post('/api/conversations/:id/chat/stream', async ctx => {
    const id = ctx.params.id;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    // Parsed above the stream, so a schema failure is an ordinary 400 rather than
    // an SSE error event a browser has to special-case.
    const body = chatRequestSchema.parse(await ctx.body());
    return sseResponse(async sink => {
      try {
        // Enforced in the browser composer too. Enforcing them only there leaves
        // every non-browser client able to post an image to a text-only model, or
        // hand Pi `/model` as a literal prompt.
        assertSupportedSlashCommand(body.message);
        await assertRuntimeRunning(llama);

        // Load the model this conversation will actually answer with (piHarness
        // resolves the same way), or the run loads one model and answers with another.
        const activeModel = await resolveConversationModel(conversations, store, id);
        if (activeModel) {
          await ensureModelReadyForRun({
            llama,
            modelCache,
            ggufMetadata,
            conversationId: id,
            modelId: activeModel.id,
            write: event => writeChatEvent(sink, event, id),
            log,
          });
        }
        // The client references uploads; the server turns them into what the
        // harness reads, deciding for each PDF whether to send its text or its
        // pages. The per-message limits are checked after that expansion, because a
        // six-page scan is six attachments. Runs after the load, so `model_cache`
        // can answer whether the model sees images.
        const resolved = await resolveChatAttachments(
          uploads,
          body.attachments ?? [],
          {
            // llama.cpp's answer if it has one, else the configured cap, else
            // `null` -- which skips the pre-flight rather than refusing on a guess.
            contextSize: activeModel ? effectiveContextWindow(activeModel, modelCache) : null,
            visionSupport: activeModel ? modelCache.getVisionSupport(activeModel.id) : null,
          },
          {maxImageMegapixels: attachmentSetting(settings, MAX_IMAGE_MEGAPIXELS_KEY)},
        );
        // The model that will *answer* -- the same one `resolveChatAttachments` just
        // gated against. This used to re-check against `state.activeModelId`, the
        // global default, so a chat pinned to a vision model had its images refused
        // whenever some other model happened to be globally active.
        assertSupportedAttachments(resolved.attachments, modelCache, activeModel?.id ?? null);
        for (const reference of body.attachments ?? []) {
          uploads.markBound(reference.uploadId);
        }

        const streamResult = await createChatStream({
          log,
          store,
          pi,
          conversationId: id,
          message: body.message,
          attachments: resolved.attachments,
        });
        await writeChatStream(sink, streamResult.stream, id);
        if (streamResult.syncLegacyState) {
          conversations.syncLegacyDefaultConversationFromState(await store.getState(), {
            forceLegacyProjection: true,
          });
        }
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });

  /**
   * Draft attachments. The client posts bytes; the server classifies them,
   * extracts PDF text, and rejects what no model here can read. The message that
   * follows references the upload by id.
   */
  router.post('/api/uploads', async ctx => {
    const form = await ctx.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return json(
        {error: {code: NELLE_ERROR_CODES.invalidRequest, message: 'Attach a file to upload.'}},
        400,
      );
    }
    if (file.size > ATTACHMENT_LIMITS.maxFileBytes) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.unsupportedAttachment,
            message: `Attachments are limited to ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MiB per file.`,
            retryable: false,
          },
        },
        413,
      );
    }
    const bytes = Buffer.from(await file.arrayBuffer());
    const conversationId = stringField(form.get('conversationId'));
    // `req.formData()` appends `;charset=utf-8` to text types; the pipeline wants
    // the bare mime type, which is what `@fastify/multipart` gave it.
    const mimeType = (file.type || 'application/octet-stream').split(';')[0]!.trim();
    let ingested;
    try {
      ingested = await ingestUpload({
        name: file.name,
        mimeType,
        bytes,
        maxImageMegapixels: attachmentSetting(settings, MAX_IMAGE_MEGAPIXELS_KEY),
      });
    } catch (error) {
      return json({error: unsupportedAttachmentError(error)}, 400);
    }

    // Refused when the file is chosen, not when the message is sent. `null` means
    // llama.cpp has never reported props, so the model is unproven rather than
    // proven text-only; the client keeps its own conservative UI gate.
    //
    // Gated against the **conversation's** model, which is what will answer -- the form
    // has carried `conversationId` all along. Reading the global `activeModelId` here
    // refused an image for a chat pinned to a vision model whenever some other model was
    // globally active, and accepted one the answering model could not see.
    const uploadModel = conversationId
      ? await resolveConversationModel(conversations, store, conversationId)
      : await store.getActiveModel();
    const visionSupport = uploadModel ? modelCache.getVisionSupport(uploadModel.id) : null;
    // A PDF with no text layer is a scan: page images are the only way to read it.
    const isScan = ingested.kind === 'pdf' && !ingested.textContent;
    if (visionSupport === false && (ingested.kind === 'image' || isScan)) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.unsupportedAttachment,
            message: isScan
              ? `${ingested.name} has no text layer, so it can only be read as page images, and the selected model cannot read images. Choose a vision model.`
              : 'The selected model cannot read images. Choose a vision model, or attach a text or PDF file.',
          },
        },
        400,
      );
    }

    const upload = await uploads.create({
      conversationId,
      kind: ingested.kind,
      name: ingested.name,
      mimeType: ingested.mimeType,
      bytes: ingested.bytes,
      textContent: ingested.textContent,
      pageCount: ingested.pageCount,
    });
    // Typed through the contract, so the body and the schema a client codegens from
    // cannot drift apart.
    const body: UploadResponse = {
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      textPreview: ingested.textContent?.slice(0, 500),
      pageCount: ingested.pageCount,
      /** PDFs only. `false` means a scan, which reaches the model as page images. */
      hasTextLayer: ingested.kind === 'pdf' ? Boolean(ingested.textContent) : undefined,
      warnings: ingested.warnings,
    };
    return json(body, 201);
  });

  router.get('/api/uploads/:uploadId', async ctx => {
    const upload = uploads.get(ctx.params.uploadId);
    if (!upload) {
      return json({error: {code: NELLE_ERROR_CODES.notFound, message: 'Upload not found.'}}, 404);
    }
    return json({
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      text: upload.textContent,
      createdAt: upload.createdAt,
      bound: Boolean(upload.boundAt),
    });
  });

  router.delete('/api/uploads/:uploadId', async ctx => {
    const deleted = await uploads.deleteUnbound(ctx.params.uploadId);
    if (!deleted) {
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'No unsent upload with that id.'}},
        404,
      );
    }
    return json({ok: true});
  });

  router.post('/api/conversations/:id/messages/:messageId/regenerate', async ctx => {
    const {id, messageId} = ctx.params;
    if (!conversations.getConversation(id)) {
      return conversationNotFound(id);
    }
    const body = regenerateMessageSchema.parse(await ctx.body()) ?? {};
    return sseResponse(async sink => {
      try {
        if (process.env.NELLE_PI_DISABLED === '1') {
          throw new Error('Regeneration requires the Pi harness.');
        }
        await assertRuntimeRunning(llama);
        // An explicit override wins (that is what a footer model change is);
        // otherwise regenerate on the conversation's own model.
        const regenerateModel = body.modelId
          ? await store.getModel(body.modelId)
          : await resolveConversationModel(conversations, store, id);
        if (regenerateModel) {
          await ensureModelReadyForRun({
            llama,
            modelCache,
            ggufMetadata,
            conversationId: id,
            modelId: regenerateModel.id,
            write: event => writeChatEvent(sink, event, id),
            log,
          });
        }
        const stream = await pi.regenerateMessage({
          conversationId: id,
          assistantMessageId: messageId,
          modelId: body.modelId,
        });
        await writeChatStream(sink, stream, id);
      } catch (error) {
        writeChatError(sink, error);
      }
    });
  });

  /**
   * The bytes of an attachment a message already carries.
   *
   * This exists because of the phone. A past message's bytes are not on the client and
   * never were: the composer previews an image because it just read those bytes off
   * disk, but a transcript loaded from a snapshot has only metadata. Until now the only
   * honest thing a client could render for a past attachment was a chip.
   *
   * `storage_path` comes out of the database, so it is not trusted as a path: it is
   * resolved against the data directory and refused if it escapes, and refused again if
   * it is not under the attachments tree. A row is not a capability to read any file on
   * the machine.
   */
  router.get('/api/attachments/:id/content', async ctx => {
    const attachment = conversations.getAttachmentById(ctx.params.id);
    if (!attachment?.storagePath) {
      // No row, or a row whose bytes were never stored (a text attachment lives in the
      // database, not on disk).
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'Attachment not found.'}},
        404,
      );
    }

    const resolved = resolveRelativeDataPath(paths.dataDir, attachment.storagePath);
    if (!resolved || !isPathWithin(resolved, path.resolve(paths.attachmentsDir))) {
      log.warn(
        {attachmentId: attachment.id},
        'attachment storage path escapes the attachments tree',
      );
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'Attachment not found.'}},
        404,
      );
    }

    const file = Bun.file(resolved);
    if (!(await file.exists())) {
      return json(
        {error: {code: NELLE_ERROR_CODES.notFound, message: 'The attachment file is missing.'}},
        404,
      );
    }

    return new Response(file, {
      headers: {
        'content-type': attachment.mimeType ?? 'application/octet-stream',
        // Content-addressed: the bytes at this id can never change, so a client may
        // keep them forever. That is what makes a phone's transcript cheap to reopen.
        'cache-control': 'private, max-age=31536000, immutable',
        // The name is the user's, and a browser will happily execute what it is handed.
        'content-disposition': `inline; filename="${encodeURIComponent(attachment.name)}"`,
        'x-content-type-options': 'nosniff',
      },
    });
  });

  // --- Device authentication (LAN clients) ---
  // Loopback is trusted; code minting and device management are hidden from the
  // LAN (they 404 there). `pair` and `auth/refresh` are token-exempt so a device
  // can bootstrap; everything else on the LAN listener needs a bearer token.

  router.post('/api/pair/code', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    const minted = devices.mintPairingCode();
    return json({
      code: minted.code,
      expiresAt: minted.expiresAt,
      qrPayload: buildPairingPayload({
        code: minted.code,
        expiresAt: minted.expiresAt,
        cert: serverCert,
        tlsPort,
        addresses: localIPv4s(),
      }),
    });
  });

  router.post('/api/pair', async ctx => {
    const body = pairRequestSchema.parse(await ctx.body());
    const tokens = devices.pair({code: body.code, name: body.deviceName, platform: body.platform});
    if (!tokens) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.pairingCodeInvalid,
            message: 'Invalid or expired pairing code.',
            retryable: false,
          },
        },
        400,
      );
    }
    return json(tokens);
  });

  router.post('/api/auth/refresh', async ctx => {
    const body = refreshRequestSchema.parse(await ctx.body());
    const tokens = devices.refresh(body.refreshToken);
    if (!tokens) {
      return json(
        {
          error: {
            code: NELLE_ERROR_CODES.refreshTokenInvalid,
            message: 'Invalid or expired refresh token.',
            retryable: false,
          },
        },
        401,
      );
    }
    return json(tokens);
  });

  router.get('/api/devices', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    return json({devices: devices.list()});
  });

  router.delete('/api/devices/:id', async ctx => {
    if (!ctx.trusted) {
      return loopbackOnly(ctx);
    }
    if (!devices.revoke(ctx.params.id)) {
      return json({error: {code: NELLE_ERROR_CODES.notFound, message: 'Device not found.'}}, 404);
    }
    return json({ok: true});
  });

  // The machine-readable API contract, derived from the zod schemas + the live
  // route list, for client codegen. See plans/nelle-pre-flutter-prep.md.
  router.get('/api/openapi.json', async () => json(buildOpenApiDocument(router.routes())));

  const staticHandler = (await hasBuiltWeb(paths.webDistDir))
    ? createStaticHandler(paths.webDistDir)
    : null;

  const handle = async (req: Request, opts: {trusted: boolean}): Promise<Response> => {
    if (req.method === 'OPTIONS') {
      return preflightResponse(req);
    }
    const url = new URL(req.url);
    // A LAN client needs a valid device access token for everything but health
    // and the pairing/refresh endpoints. Loopback is trusted and skips this.
    if (
      !opts.trusted &&
      url.pathname.startsWith('/api/') &&
      !AUTH_ALLOWLIST.has(url.pathname) &&
      !authorizeBearer(req, devices)
    ) {
      return applyCors(
        req,
        json(
          {
            error: {
              code: NELLE_ERROR_CODES.unauthorized,
              message: 'Authentication required.',
              retryable: false,
            },
          },
          401,
        ),
      );
    }
    const routed = await router.dispatch(req, url, opts.trusted);
    if (routed) {
      return applyCors(req, routed);
    }
    // An unknown API path is a 404 JSON, never the SPA: a non-browser client
    // expects JSON, and a typo'd endpoint returning index.html hides the mistake.
    if (url.pathname.startsWith('/api/')) {
      return applyCors(
        req,
        json(
          {
            error: {
              code: NELLE_ERROR_CODES.notFound,
              message: `No route for ${req.method} ${url.pathname}.`,
            },
          },
          404,
        ),
      );
    }
    // Any other unmatched path falls to the SPA (a file if one exists, else
    // `index.html`), for every method -- the `setNotFoundHandler` fallback.
    if (staticHandler) {
      const served = await staticHandler(url.pathname);
      if (served) {
        return applyCors(req, served);
      }
    }
    return applyCors(
      req,
      json(
        {
          error: {
            code: NELLE_ERROR_CODES.notFound,
            message: `No route for ${req.method} ${url.pathname}.`,
          },
        },
        404,
      ),
    );
  };

  return {
    handle,
    close: async () => {
      clearInterval(uploadSweepTimer);
      database.close();
    },
    lanAccessEnabled,
    serverCert,
  };
}

/** Mimics the unknown-route 404 so a loopback-only endpoint is invisible from the LAN. */
function loopbackOnly(ctx: Ctx): Response {
  return json(
    {
      error: {
        code: NELLE_ERROR_CODES.notFound,
        message: `No route for ${ctx.req.method} ${ctx.url.pathname}.`,
      },
    },
    404,
  );
}

type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

/** A minimal console logger with pino's `(mergingObject, message)` call shape. */
function createLogger(): Logger {
  const write = (level: 'info' | 'warn' | 'error', obj: unknown, msg?: string): void => {
    const message = typeof obj === 'string' ? obj : msg;
    const detail = typeof obj === 'string' ? undefined : obj;
    const line = `[nelle] ${level}: ${message ?? ''}`.trimEnd();
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    if (detail === undefined) {
      sink(line);
    } else {
      sink(line, detail);
    }
  };
  return {
    info: (obj, msg) => write('info', obj, msg),
    warn: (obj, msg) => write('warn', obj, msg),
    error: (obj, msg) => write('error', obj, msg),
  };
}

function conversationNotFound(id: string): Response {
  return json(
    {error: {code: 'conversation_not_found', message: `Conversation ${id} was not found.`}},
    404,
  );
}

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

/**
 * Runs an SSE producer against a `{write}` sink backed by a `ReadableStream`
 * controller -- the same sink shape `reply.raw` gave the stream writers, so they
 * are unchanged.
 */
function sseResponse(run: (sink: {write: (chunk: string) => void}) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sink = {write: (chunk: string) => controller.enqueue(encoder.encode(chunk))};
      try {
        await run(sink);
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed (e.g. the client went away).
        }
      }
    },
  });
  return new Response(stream, {status: 200, headers: SSE_HEADERS});
}

async function createChatStream(input: {
  log: {warn: (input: unknown, message?: string) => void};
  store: AppStore;
  pi: PiHarness;
  conversationId: string;
  message: string;
  attachments: ChatAttachmentInput[];
}): Promise<{stream: AsyncIterable<ChatStreamEvent>; syncLegacyState: boolean}> {
  if (process.env.NELLE_PI_DISABLED === '1') {
    if (input.conversationId !== LEGACY_DEFAULT_CONVERSATION_ID) {
      throw new Error('Direct llama.cpp fallback only supports the default conversation.');
    }
    return {
      stream: await streamDirectLlama(
        input.store,
        input.conversationId,
        input.message,
        input.attachments,
      ),
      syncLegacyState: true,
    };
  }
  try {
    return {
      stream: await input.pi.streamPrompt(input.message, input.conversationId, input.attachments),
      syncLegacyState: false,
    };
  } catch (error) {
    input.log.warn({err: error}, 'Pi harness failed before streaming');
    if (input.conversationId !== LEGACY_DEFAULT_CONVERSATION_ID) {
      throw error;
    }
    return {
      stream: await streamDirectLlama(
        input.store,
        input.conversationId,
        input.message,
        input.attachments,
      ),
      syncLegacyState: true,
    };
  }
}

async function writeChatStream(
  raw: {write: (chunk: string) => void},
  stream: AsyncIterable<ChatStreamEvent>,
  conversationId: string,
): Promise<void> {
  for await (const event of stream) {
    writeChatEvent(raw, event, conversationId);
  }
}

function writeChatEvent(
  raw: {write: (chunk: string) => void},
  event: ChatStreamEvent,
  conversationId: string,
): void {
  raw.write(
    serializeSseEnvelope(
      createEventEnvelope({
        type: event.type,
        conversationId: eventConversationId(event, conversationId),
        runId: eventRunId(event),
        data: event,
      }),
    ),
  );
}

function writeChatError(raw: {write: (chunk: string) => void}, error: unknown): void {
  const event: ChatStreamEvent = createErrorEvent(error, {fallbackCode: 'stream_failed'});
  raw.write(
    serializeSseEnvelope(
      createEventEnvelope({
        type: event.type,
        data: event,
      }),
    ),
  );
}

function eventConversationId(event: ChatStreamEvent, fallback: string): string {
  if ('conversationId' in event && typeof event.conversationId === 'string') {
    return event.conversationId;
  }
  return fallback;
}

function eventRunId(event: ChatStreamEvent): string | undefined {
  if ('runId' in event && typeof event.runId === 'string') {
    return event.runId;
  }
  return undefined;
}

async function handleLlamaRoute<T>(
  action: () => Promise<T>,
  code = 'llama_router_request_failed',
): Promise<Response> {
  try {
    return json(await action());
  } catch (error) {
    return llamaError(error, code);
  }
}

/**
 * The server knows exactly which keys failed and what each should probably have
 * been, so it says so. One line of red text for a form with ten rows tells a
 * client nothing it can mark, and the next client would have to guess the same
 * way. `error.code` stays a single value for a client that reads only that.
 */
function invalidModelParamsResponse(invalid: InvalidModelParam[]): {
  error: NelleError;
  invalidParams: InvalidModelParam[];
} {
  return {
    error: {
      code: invalidModelParamsCode(invalid),
      message: invalidModelParamsMessage(invalid),
      retryable: false,
    },
    invalidParams: invalid,
  };
}

/**
 * Makes the requested model runnable, streaming progress while it loads.
 *
 * The browser used to do this: post a load, poll `/models` sixty times at half a
 * second, watch for `failed`, give up at thirty. Every client would have copied
 * it. Now the run waits here and reports what it is waiting for.
 *
 * The props fetch afterwards is not incidental. `GET /api/llama/models/:id/props`
 * was the only writer of `model_cache`'s modality and context columns, and it
 * fires because a client asked. Once the server loads models itself, nothing asks,
 * and every capability derived from props degrades to "unknown" for exactly the
 * thin client this exists to serve.
 */
async function ensureModelReadyForRun(input: {
  llama: LlamaCppManager;
  modelCache: ModelCacheRepository;
  ggufMetadata: GgufMetadataRepository;
  conversationId: string;
  modelId: string;
  write: (event: ChatStreamEvent) => void;
  log: {warn: (input: unknown, message?: string) => void};
}): Promise<void> {
  const result = await input.llama.ensureModelRunnable(input.modelId, {
    onProgress: update =>
      input.write({
        type: 'model.loading',
        conversationId: input.conversationId,
        modelId: input.modelId,
        status: update.status,
        progress: update.progress,
        createdAt: new Date().toISOString(),
      }),
  });
  if (!result.loaded) {
    return;
  }
  try {
    await recordModelProps({
      sectionId: input.modelId,
      props: await input.llama.getModelProps(input.modelId),
      modelCache: input.modelCache,
      ggufMetadata: input.ggufMetadata,
      onError: error =>
        input.log.warn({err: error, modelId: input.modelId}, 'could not parse the GGUF header'),
    });
  } catch (error) {
    // A model that will not describe itself can still answer a prompt. Losing the
    // cache entry costs a capability, not the run.
    input.log.warn({err: error, modelId: input.modelId}, 'could not cache model props after load');
  }
}

/** A numeric attachment setting, or `undefined` when the registry lacks the group. */
function attachmentSetting(settings: SettingsRepository, key: string): number | undefined {
  const value = settings.tryGetGroup(ATTACHMENTS_SETTINGS_SLUG)?.[key];
  return typeof value === 'number' ? value : undefined;
}

/** llama.cpp is not running, so no run of any kind can start. */
async function assertRuntimeRunning(llama: LlamaCppManager): Promise<void> {
  if ((await llama.getStatus()).running) {
    return;
  }
  const error = new Error('llama.cpp is not running. Start it in Settings > Runtime.');
  Object.assign(error, {code: NELLE_ERROR_CODES.llamaServerStopped, retryable: true});
  throw error;
}

/**
 * Nelle's chat composer owns a slash-command allowlist. The server owns it too,
 * or `/model` reaches Pi as a literal prompt from any other client.
 */
function assertSupportedSlashCommand(message: string): void {
  const refusal = unsupportedSlashCommandMessage(message);
  if (!refusal) {
    return;
  }
  const error = new Error(refusal);
  Object.assign(error, {code: NELLE_ERROR_CODES.unsupportedSlashCommand, retryable: false});
  throw error;
}

/**
 * Image attachments need a vision model. `null` means llama.cpp has never
 * reported props, so the model is unproven rather than proven text-only; let it
 * through and let llama.cpp reject it.
 */
/**
 * Refuses an image the answering model has been *proven* unable to see.
 *
 * [modelId] is the **conversation's** model, not the global default: since M2 those are
 * different things, and the run answers on the conversation's. `null` (no model at all)
 * and an unproven model both pass -- the tri-state rule is that only `false` refuses.
 */
export function assertSupportedAttachments(
  attachments: ChatAttachmentInput[],
  modelCache: ModelCacheRepository,
  modelId: string | null,
): void {
  const hasImage = attachments.some(attachment => attachment.kind === 'image');
  if (!hasImage || !modelId) {
    return;
  }
  if (modelCache.getVisionSupport(modelId) !== false) {
    return;
  }
  const error = new Error(
    'The selected model cannot read images. Choose a vision model, or remove the image attachments.',
  );
  Object.assign(error, {code: NELLE_ERROR_CODES.unsupportedAttachment, retryable: false});
  throw error;
}

/** Multipart text fields arrive as strings under `req.formData()`. */
function stringField(value: FormDataEntryValue | null): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function unsupportedAttachmentError(error: unknown): NelleError {
  return {
    code: NELLE_ERROR_CODES.unsupportedAttachment,
    message:
      error instanceof UnsupportedAttachmentError || error instanceof Error
        ? error.message
        : 'The attachment could not be read.',
    retryable: false,
  };
}

async function writePresetAndReloadRouter(
  llama: LlamaCppManager,
  store: AppStore,
  modelCache: ModelCacheRepository,
): Promise<void> {
  await llama.writePreset();
  // A removed models.ini section leaves a cache row pointing at a model that no
  // longer exists; the next snapshot would gate attachments on its modalities.
  modelCache.pruneMissingSections((await store.getState()).models.map(model => model.id));
  if ((await llama.getStatus()).running) {
    const result = await llama.getRouterModels({reload: true});
    modelCache.upsertRouterModels(result.models);
  }
}

function llamaError(error: unknown, code = 'llama_router_request_failed'): Response {
  return json(
    {
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    },
    502,
  );
}

async function hasBuiltWeb(webDistDir: string): Promise<boolean> {
  try {
    await fs.access(path.join(webDistDir, 'index.html'));
    return true;
  } catch {
    return false;
  }
}

type FileCleanupResult = {
  deleted: number;
  skipped: number;
  failed: Array<{path: string; message: string}>;
};

async function deleteConversationResources(
  paths: AppPaths,
  resources: ConversationDeleteResources,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {deleted: 0, skipped: 0, failed: []};
  for (const sessionPath of resources.piSessionPaths) {
    await unlinkOwnedPath(paths.piSessionsDir, sessionPath, result);
  }
  for (const storagePath of resources.attachmentStoragePaths) {
    const attachmentPath = resolveRelativeDataPath(paths.dataDir, storagePath);
    if (!attachmentPath) {
      result.skipped += 1;
      continue;
    }
    await unlinkOwnedPath(paths.dataDir, attachmentPath, result, paths.attachmentsDir);
  }
  return result;
}

async function sweepOrphanAttachmentFiles(
  paths: AppPaths,
  referencedStoragePaths: Set<string>,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {deleted: 0, skipped: 0, failed: []};
  const attachmentsRoot = path.resolve(paths.attachmentsDir);
  const dataRoot = path.resolve(paths.dataDir);

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      result.failed.push({
        path: path.resolve(directory),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        result.skipped += 1;
        continue;
      }

      const storagePath = path
        .relative(dataRoot, path.resolve(absolutePath))
        .split(path.sep)
        .join('/');
      if (referencedStoragePaths.has(storagePath)) {
        continue;
      }
      await unlinkOwnedPath(attachmentsRoot, absolutePath, result, attachmentsRoot);
    }
  }

  await visit(attachmentsRoot);
  return result;
}

async function unlinkOwnedPath(
  root: string,
  candidatePath: string,
  result: FileCleanupResult,
  pruneRoot = root,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(candidatePath);
  if (!isPathWithin(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    result.skipped += 1;
    return;
  }
  try {
    await fs.unlink(resolvedPath);
    result.deleted += 1;
    await pruneEmptyParents(path.dirname(resolvedPath), pruneRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.skipped += 1;
      return;
    }
    result.failed.push({
      path: resolvedPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveRelativeDataPath(dataDir: string, relativePath: string): string | null {
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  return isPathWithin(resolved, path.resolve(dataDir)) ? resolved : null;
}

async function pruneEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(start);
  while (isPathWithin(current, resolvedRoot) && current !== resolvedRoot) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function isPathWithin(candidatePath: string, root: string): boolean {
  return candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
}
