import path from 'node:path';
import fs from 'node:fs/promises';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import {ZodError, z} from 'zod';

import {
  reasoningBudgetsSchema,
  reasoningLevelSchema,
} from '../../../packages/shared/src/reasoning.ts';
import {HuggingFaceService} from './huggingface';
import {LlamaCppManager} from './llamacpp';
import {registerLlamaProxy} from './llamaProxy';
import {PiHarness, isConversationNotFoundError} from './piHarness';
import {streamDirectLlama} from './directLlama';
import {createErrorEvent, normalizeNelleError} from './errors';
import {AppStore} from './store';
import {AppDatabase} from './database';
import {exportConversationArchive, importConversationArchive} from './conversationArchive';
import {HostToolRepository} from './hostTools';
import {PreferencesRepository} from './preferences';
import {UPLOAD_SWEEP_INTERVAL_MS, UploadRepository} from './uploads';
import {ingestUpload, UnsupportedAttachmentError} from './attachmentIngest';
import {ATTACHMENT_LIMITS} from '../../../packages/shared/src/attachments.ts';
import {ModelCacheRepository} from './modelCache';
import {
  ConversationRepository,
  LEGACY_DEFAULT_CONVERSATION_ID,
  type ConversationDeleteResources,
} from './conversations';
import type {AppPaths} from './paths';
import type {AppState, ChatAttachmentInput, ChatStreamEvent} from './types';
import type {NelleError} from '../../../packages/shared/src/contracts.ts';
import {
  chatRequestSchema,
  createEventEnvelope,
  preferencesSchema,
  serializeSseEnvelope,
  NELLE_ERROR_CODES,
} from '../../../packages/shared/src/contracts.ts';
import {
  SLASH_COMMAND_REGISTRY,
  unsupportedSlashCommandMessage,
} from '../../../packages/shared/src/commands.ts';

const useHuggingFaceModelSchema = z.object({
  repoId: z.string().min(1),
  quant: z.string().min(1),
  name: z.string().optional(),
});

const runtimeSettingsSchema = z.object({
  modelsMax: z.number().int().min(1).optional(),
  sleepIdleSeconds: z.number().int().min(0).optional(),
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

const reasoningSettingsSchema = z.object({budgets: reasoningBudgetsSchema});

const hostToolSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  acknowledged: z.boolean().optional(),
});

export async function createServer(paths: AppPaths) {
  const store = new AppStore(paths);
  const database = new AppDatabase(paths);
  await database.open();
  const conversations = new ConversationRepository(database);
  await conversations.init();
  const hostTools = new HostToolRepository(database);
  const preferences = new PreferencesRepository(database);
  const modelCache = new ModelCacheRepository(database);
  const uploads = new UploadRepository(database, paths);
  const llama = new LlamaCppManager(paths, store);
  const hf = new HuggingFaceService(store);
  const pi = new PiHarness(paths, store, conversations, hostTools, llama, modelCache);
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

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });
  if (attachmentSweep.deleted > 0 || attachmentSweep.failed.length > 0) {
    app.log.info({attachmentSweep}, 'completed orphan attachment sweep');
  }
  if (uploadSweep.deleted > 0 || uploadSweep.orphanDirectories > 0) {
    app.log.info({uploadSweep}, 'completed expired upload sweep');
  }
  const uploadSweepTimer = setInterval(() => {
    void uploads
      .sweepExpired()
      .then(result => {
        if (result.deleted > 0) {
          app.log.info({uploadSweep: result}, 'swept expired uploads');
        }
        return result;
      })
      .catch(error => {
        app.log.warn({error}, 'expired upload sweep failed');
      });
  }, UPLOAD_SWEEP_INTERVAL_MS);
  // A timer that keeps the process alive would hang `npm run test:unit`.
  uploadSweepTimer.unref();
  // Every route validates its body with zod before it writes anything, including
  // the SSE routes, which call `parse` above `writeHead`. So a schema failure can
  // always become an ordinary response -- and it must, because Fastify's default
  // turns it into an HTTP 500 whose body is a serialized zod issue array. A
  // second client would get no code to branch on and a wall of JSON to read.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({error: nelleErrorFromZod(error)});
    }
    // `@fastify/multipart` aborts the stream past its limit and serializes its
    // own body. A client needs a `NelleError` code here as much as anywhere.
    if ((error as {code?: string}).code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({
        error: {
          code: NELLE_ERROR_CODES.unsupportedAttachment,
          message: `Attachments are limited to ${formatMebibytes(ATTACHMENT_LIMITS.maxFileBytes)} per file.`,
          retryable: false,
        },
      });
    }
    return reply.send(error);
  });

  app.addContentTypeParser(
    ['application/zip', 'application/octet-stream'],
    {parseAs: 'buffer'},
    (_request, body, done) => {
      done(null, body);
    },
  );

  await app.register(cors, {
    origin: true,
  });
  app.addHook('onClose', async () => {
    clearInterval(uploadSweepTimer);
    database.close();
  });
  await app.register(multipart, {
    limits: {
      fileSize: ATTACHMENT_LIMITS.maxFileBytes,
      // One file per request keeps the per-file limit enforceable by the parser.
      files: 1,
    },
  });
  registerLlamaProxy(app, store);

  app.get('/api/health', async () => ({
    ok: true,
    app: 'nelle-server',
    dataDir: paths.dataDir,
    runtime: await llama.getStatus(),
  }));

  // The composer's typeahead and its refusal copy come from here, so
  // allowlisting a command ships without touching a client.
  app.get('/api/commands', async () => ({
    commands: SLASH_COMMAND_REGISTRY.commands,
    unsupported: SLASH_COMMAND_REGISTRY.unsupported,
  }));

  app.get('/api/state', async () => ({
    state: await store.getState(),
    runtime: await llama.getStatus(),
    hostTools: hostTools.getSettings(),
  }));

  app.get('/api/settings/host-tools', async () => ({
    hostTools: hostTools.getSettings(),
  }));

  // Favorites follow the user, not the browser profile that set them.
  app.get('/api/settings/preferences', async () => {
    const state = await store.getState();
    return preferences.getPreferences(state.models.map(model => model.id));
  });

  app.patch('/api/settings/preferences', async request => {
    const body = preferencesSchema.parse(request.body);
    const saved = preferences.updatePreferences(body);
    const state = await store.getState();
    const known = new Set(state.models.map(model => model.id));
    return {favoriteModelIds: saved.favoriteModelIds.filter(id => known.has(id))};
  });

  app.patch('/api/settings/reasoning', async request => {
    const body = reasoningSettingsSchema.parse(request.body);
    return {budgets: await store.updateReasoningBudgets(body.budgets)};
  });

  app.patch('/api/settings/host-tools', async (request, reply) => {
    const body = hostToolSettingsSchema.parse(request.body);
    let settings;
    try {
      settings = hostTools.updateSettings(body);
    } catch (error) {
      return reply.status(400).send({
        error: {
          code: 'host_tools_acknowledgement_required',
          message:
            error instanceof Error
              ? error.message
              : 'Host tools must be acknowledged before they can be enabled.',
        },
      });
    }
    pi.resetSession();
    return {hostTools: settings};
  });

  app.get('/api/runtime', async request => {
    const checkLatest = (request.query as {latest?: string}).latest === '1';
    return llama.getStatus(checkLatest);
  });

  app.post('/api/runtime/install', async () => llama.installOrUpdate());
  app.post('/api/runtime/update', async () => llama.installOrUpdate());
  app.post('/api/runtime/start', async () => llama.start());
  app.post('/api/runtime/stop', async () => llama.stop());
  app.get('/api/runtime/logs', async request => {
    const requestedBytes = Number((request.query as {maxBytes?: string}).maxBytes ?? 80_000);
    const maxBytes = Number.isFinite(requestedBytes)
      ? Math.min(Math.max(0, requestedBytes), 1_000_000)
      : 80_000;
    return llama.readLogTail(maxBytes);
  });
  app.patch('/api/runtime/settings', async request => {
    const body = runtimeSettingsSchema.parse(request.body);
    return {runtime: await store.updateRuntimeSettings(body)};
  });

  app.get('/api/llama/props', async (_request, reply) =>
    handleLlamaRoute(reply, () => llama.getRouterProps()),
  );

  app.get('/api/llama/models', async (_request, reply) =>
    handleLlamaRoute(reply, async () => {
      const result = await llama.getRouterModels();
      modelCache.upsertRouterModels(result.models);
      return result;
    }),
  );

  app.post('/api/llama/models/reload', async (_request, reply) =>
    handleLlamaRoute(reply, async () => {
      const result = await llama.getRouterModels({reload: true});
      modelCache.upsertRouterModels(result.models);
      return result;
    }),
  );

  app.get('/api/llama/models/events', async (request, reply) => {
    const controller = new AbortController();
    request.raw.on('close', () => controller.abort());
    let upstream: Response;
    try {
      upstream = await llama.fetchRouterStream('/models/sse', controller.signal);
    } catch (error) {
      return sendLlamaError(reply, error);
    }

    if (!upstream.ok || !upstream.body) {
      return sendLlamaError(
        reply,
        new Error(
          upstream.body
            ? `llama.cpp router events failed: ${upstream.status}`
            : 'llama.cpp router events response did not include a stream.',
        ),
      );
    }

    reply.raw.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
      'cache-control': upstream.headers.get('cache-control') ?? 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) {
          break;
        }
        reply.raw.write(value);
      }
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
  });

  app.get('/api/llama/models/:id/props', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(reply, async () => {
      const props = await llama.getModelProps(id);
      // A sleeping model answers /props with an error, so only a success caches.
      modelCache.upsertModelProps(id, props);
      return props;
    });
  });

  app.post('/api/llama/tokenize', async (request, reply) => {
    const body = tokenizeSchema.parse(request.body);
    return handleLlamaRoute(reply, () => llama.tokenize(body.content, body));
  });

  app.post('/api/llama/models/:id/load', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(
      reply,
      () => llama.loadRouterModel(id),
      NELLE_ERROR_CODES.modelLoadFailed,
    );
  });

  app.post('/api/llama/models/:id/unload', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    return handleLlamaRoute(reply, () => llama.unloadRouterModel(id));
  });

  app.get('/api/models', async () => {
    const state = await store.getState();
    return {
      models: state.models,
      activeModelId: state.activeModelId,
      globalModelParams: state.globalModelParams,
    };
  });

  app.post('/api/models/:id/activate', async request => {
    const id = (request.params as {id: string}).id;
    const model = await store.setActiveModel(id);
    await llama.writePreset(model);
    return {model};
  });

  app.patch('/api/models/global-params', async (request, reply) => {
    const body = updateGlobalModelParamsSchema.parse(request.body);
    const validation = validateEditableParams(body.params);
    if (validation) {
      return reply.status(400).send({error: validation});
    }
    const globalModelParams = await store.updateGlobalModelParams(body.params);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return {globalModelParams};
  });

  app.patch('/api/models/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const body = updateModelSchema.parse(request.body);
    if (body.params) {
      const validation = validateEditableParams(body.params, new Set(['hf-repo', 'alias']));
      if (validation) {
        return reply.status(400).send({error: validation});
      }
    }
    let model;
    try {
      model = await store.updateModel(id, body);
    } catch (error) {
      return reply.status(404).send({
        error: {
          code: 'model_not_found',
          message: error instanceof Error ? error.message : `Unknown model: ${id}`,
        },
      });
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    return {model, state: await store.getState()};
  });

  app.post('/api/models/:id/duplicate', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    let model;
    try {
      model = await store.duplicateModel(id);
    } catch (error) {
      return reply.status(404).send({
        error: {
          code: 'model_not_found',
          message: error instanceof Error ? error.message : `Unknown model: ${id}`,
        },
      });
    }
    await writePresetAndReloadRouter(llama, store, modelCache);
    return {model, state: await store.getState()};
  });

  app.delete('/api/models/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const removed = await store.removeModel(id);
    if (!removed) {
      return reply.status(404).send({
        error: {
          code: 'model_not_found',
          message: `Unknown model: ${id}`,
        },
      });
    }
    await llama.removeModelSection(id);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return {ok: true, removedModelId: id, state: await store.getState()};
  });

  app.get('/api/huggingface/search', async request => {
    const query = (request.query as {q?: string}).q ?? '';
    return {results: await hf.searchGgufModels(query)};
  });

  app.post('/api/huggingface/use', async request => {
    const body = useHuggingFaceModelSchema.parse(request.body);
    const model = await hf.useHuggingFaceGguf(body);
    await writePresetAndReloadRouter(llama, store, modelCache);
    return {model};
  });

  app.get('/api/conversations', async request => {
    const query = listConversationsQuerySchema.parse(request.query);
    await conversations.markInvalidPiSessionsUnavailable();
    return conversations.listConversations(query);
  });

  app.post('/api/conversations', async request => {
    const body = createConversationSchema.parse(request.body) ?? {};
    const snapshot = await pi.createConversation(body);
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.delete('/api/conversations', async () => {
    const resources = conversations.getAllConversationDeleteResources();
    conversations.hardDeleteAllConversations();
    hostTools.deleteAllAuditEvents();
    const cleanup = await deleteConversationResources(paths, resources);
    await store.clearChat();
    pi.resetSession();
    return {ok: true, cleanup};
  });

  app.post('/api/conversations/import', async (request, reply) => {
    const bytes = archiveBodyToBytes(request.body);
    if (!bytes) {
      return reply.status(400).send({
        error: {
          code: 'invalid_archive_upload',
          message: 'Upload a .nelle-chat.zip archive body.',
        },
      });
    }
    let imported: {conversationId: string};
    try {
      imported = await importConversationArchive({
        paths,
        store,
        conversations,
        bytes,
      });
    } catch (error) {
      return reply.status(400).send({
        error: {
          code: 'invalid_archive',
          message: error instanceof Error ? error.message : 'Archive import failed.',
        },
      });
    }
    const snapshot = conversations.getSnapshot(imported.conversationId, await store.getState());
    if (!snapshot) {
      throw new Error('Imported conversation snapshot was not available.');
    }
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.get('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const snapshot = await pi.getConversationSnapshot(id);
    if (!snapshot) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {snapshot};
  });

  app.get('/api/conversations/:id/diagnostics', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const diagnostics = await conversations.getConversationDiagnostics(id);
    if (!diagnostics) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {diagnostics};
  });

  app.post('/api/conversations/:id/repair', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    try {
      return {snapshot: await pi.repairConversation(id)};
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return reply.status(404).send({
          error: {
            code: 'conversation_not_found',
            message: `Conversation ${id} was not found.`,
          },
        });
      }
      // The session file is still unreadable. Repair never invents one.
      return reply.status(409).send({error: normalizeNelleError(error)});
    }
  });

  app.post('/api/conversations/:id/rebuild', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    try {
      return {snapshot: await pi.rebuildConversationFromProjection(id)};
    } catch (error) {
      if (isConversationNotFoundError(error)) {
        return reply.status(404).send({
          error: {
            code: 'conversation_not_found',
            message: `Conversation ${id} was not found.`,
          },
        });
      }
      return reply.status(500).send({error: normalizeNelleError(error)});
    }
  });

  app.patch('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const body = patchConversationSchema.parse(request.body);
    const conversation = conversations.patchConversation(id, body);
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {
      conversation,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.put('/api/conversations/:id/reasoning', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const body = conversationReasoningSchema.parse(request.body);
    const conversation = conversations.setReasoningLevel(id, body.level);
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {
      conversation,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/pin', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const conversation = conversations.patchConversation(id, {pinned: true});
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {conversation};
  });

  app.post('/api/conversations/:id/unpin', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const conversation = conversations.patchConversation(id, {pinned: false});
    if (!conversation) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    return {conversation};
  });

  app.delete('/api/conversations/:id', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const resources = conversations.getConversationDeleteResources(id);
    if (!resources) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    if (!conversations.hardDeleteConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    pi.resetSession(id);
    if (id === LEGACY_DEFAULT_CONVERSATION_ID) {
      await store.clearChat();
    }
    const cleanup = await deleteConversationResources(paths, resources);
    return {ok: true, cleanup};
  });

  app.post('/api/conversations/:id/export', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    const archive = await exportConversationArchive({
      paths,
      store,
      conversations,
      hostTools,
      conversationId: id,
    });
    if (!archive) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    reply.header('content-type', 'application/zip');
    reply.header(
      'content-disposition',
      `attachment; filename="${archive.filename.replace(/"/g, '')}"`,
    );
    return reply.send(Buffer.from(archive.bytes));
  });

  app.delete('/api/conversations/:id/messages', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    pi.resetSession(id);
    conversations.clearConversationProjection(id);
    hostTools.deleteAuditEventsForConversation(id);
    if (id === LEGACY_DEFAULT_CONVERSATION_ID) {
      await store.clearChat();
    }
    return {ok: true};
  });

  app.post('/api/conversations/:id/abort', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const result = await pi.abortConversation(id);
    return {
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/runs/:runId/abort', async (request, reply) => {
    const {id, runId} = request.params as {id: string; runId: string};
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const result = await pi.abortConversationRun(id, runId);
    return {
      ok: true,
      ...result,
      runId,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/compact', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = compactConversationSchema.parse(request.body) ?? {};
    const result = await pi.compactConversation(id, body.instructions);
    return {
      ok: true,
      ...result,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/compact/stream', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = compactConversationSchema.parse(request.body) ?? {};
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      if (process.env.NELLE_PI_DISABLED === '1') {
        throw new Error('Compaction requires the Pi harness.');
      }
      const stream = await pi.streamCompactConversation(id, body.instructions);
      await writeChatStream(reply.raw, stream, id);
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  app.post('/api/conversations/:id/compact/abort', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const aborted = pi.abortCompaction(id);
    return {
      ok: true,
      aborted,
      snapshot: conversations.getSnapshot(id, await store.getState()),
    };
  });

  app.post('/api/conversations/:id/fork', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = forkConversationSchema.parse(request.body);
    const snapshot = await pi.forkConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.post('/api/conversations/:id/clone', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = cloneConversationSchema.parse(request.body) ?? {};
    const snapshot = await pi.cloneConversation({
      conversationId: id,
      entryId: body.entryId,
      title: body.title,
    });
    return {
      conversation: snapshot.conversation,
      snapshot,
    };
  });

  app.post('/api/conversations/:id/chat/stream', async (request, reply) => {
    const id = (request.params as {id: string}).id;
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = chatRequestSchema.parse(request.body);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      // Enforced in the browser composer too. Enforcing them only there leaves
      // every non-browser client able to post an image to a text-only model, or
      // hand Pi `/model` as a literal prompt.
      assertSupportedSlashCommand(body.message);
      await assertRuntimeRunning(llama);

      const activeModel = await store.getActiveModel();
      if (activeModel) {
        await ensureModelReadyForRun({
          llama,
          modelCache,
          conversationId: id,
          modelId: activeModel.id,
          write: event => writeChatEvent(reply.raw, event, id),
          log: app.log,
        });
      }
      // After the load, so `model_cache` can answer whether the model sees images.
      assertSupportedAttachments(body.attachments ?? [], modelCache, await store.getState());

      const streamResult = await createChatStream({
        app,
        store,
        pi,
        conversationId: id,
        message: body.message,
        attachments: body.attachments ?? [],
      });
      await writeChatStream(reply.raw, streamResult.stream, id);
      if (streamResult.syncLegacyState) {
        conversations.syncLegacyDefaultConversationFromState(await store.getState(), {
          forceLegacyProjection: true,
        });
      }
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  /**
   * Draft attachments. The client posts bytes; the server classifies them,
   * extracts PDF text, and rejects what no model here can read. The message that
   * follows references the upload by id.
   */
  app.post('/api/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.status(400).send({
        error: {code: NELLE_ERROR_CODES.invalidRequest, message: 'Attach a file to upload.'},
      });
    }
    const bytes = await file.toBuffer();
    if (file.file.truncated) {
      return reply.status(400).send({
        error: {
          code: NELLE_ERROR_CODES.unsupportedAttachment,
          message: `${file.filename} is larger than ${Math.round(ATTACHMENT_LIMITS.maxFileBytes / (1024 * 1024))} MiB.`,
        },
      });
    }

    const conversationId = fieldValue(file.fields.conversationId);
    let ingested;
    try {
      ingested = await ingestUpload({name: file.filename, mimeType: file.mimetype, bytes});
    } catch (error) {
      return reply.status(400).send({error: unsupportedAttachmentError(error)});
    }

    // An image is refused when it is chosen, not when the message is sent. `null`
    // means llama.cpp has never reported props, so the model is unproven rather
    // than proven text-only; the client keeps its own conservative UI gate.
    const state = await store.getState();
    if (
      ingested.kind === 'image' &&
      state.activeModelId &&
      modelCache.getVisionSupport(state.activeModelId) === false
    ) {
      return reply.status(400).send({
        error: {
          code: NELLE_ERROR_CODES.unsupportedAttachment,
          message:
            'The selected model cannot read images. Choose a vision model, or attach a text or PDF file.',
        },
      });
    }

    const upload = await uploads.create({
      conversationId,
      kind: ingested.kind,
      name: ingested.name,
      mimeType: ingested.mimeType,
      bytes: ingested.bytes,
      textContent: ingested.textContent,
    });
    return reply.status(201).send({
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      textPreview: ingested.textContent?.slice(0, 500),
      pageCount: ingested.pageCount,
      warnings: ingested.warnings,
    });
  });

  app.get('/api/uploads/:uploadId', async (request, reply) => {
    const {uploadId} = request.params as {uploadId: string};
    const upload = uploads.get(uploadId);
    if (!upload) {
      return reply.status(404).send({
        error: {code: NELLE_ERROR_CODES.notFound, message: 'Upload not found.'},
      });
    }
    return {
      uploadId: upload.id,
      kind: upload.kind,
      name: upload.name,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      text: upload.textContent,
      createdAt: upload.createdAt,
      bound: Boolean(upload.boundAt),
    };
  });

  app.delete('/api/uploads/:uploadId', async (request, reply) => {
    const {uploadId} = request.params as {uploadId: string};
    const deleted = await uploads.deleteUnbound(uploadId);
    if (!deleted) {
      return reply.status(404).send({
        error: {
          code: NELLE_ERROR_CODES.notFound,
          message: 'No unsent upload with that id.',
        },
      });
    }
    return {ok: true};
  });

  app.post('/api/conversations/:id/messages/:messageId/regenerate', async (request, reply) => {
    const {id, messageId} = request.params as {id: string; messageId: string};
    if (!conversations.getConversation(id)) {
      return reply.status(404).send({
        error: {
          code: 'conversation_not_found',
          message: `Conversation ${id} was not found.`,
        },
      });
    }
    const body = regenerateMessageSchema.parse(request.body) ?? {};
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    try {
      if (process.env.NELLE_PI_DISABLED === '1') {
        throw new Error('Regeneration requires the Pi harness.');
      }
      await assertRuntimeRunning(llama);
      const regenerateModel = body.modelId
        ? await store.getModel(body.modelId)
        : await store.getActiveModel();
      if (regenerateModel) {
        await ensureModelReadyForRun({
          llama,
          modelCache,
          conversationId: id,
          modelId: regenerateModel.id,
          write: event => writeChatEvent(reply.raw, event, id),
          log: app.log,
        });
      }
      const stream = await pi.regenerateMessage({
        conversationId: id,
        assistantMessageId: messageId,
        modelId: body.modelId,
      });
      await writeChatStream(reply.raw, stream, id);
    } catch (error) {
      writeChatError(reply.raw, error);
    } finally {
      reply.raw.end();
    }
  });

  if (await hasBuiltWeb(paths.webDistDir)) {
    await app.register(staticPlugin, {
      root: paths.webDistDir,
      prefix: '/',
    });
    app.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html');
    });
  }

  return app;
}

async function createChatStream(input: {
  app: {log: {warn: (input: unknown, message?: string) => void}};
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
    input.app.log.warn({err: error}, 'Pi harness failed before streaming');
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
  reply: {status: (statusCode: number) => {send: (payload: unknown) => unknown}},
  action: () => Promise<T>,
  code = 'llama_router_request_failed',
): Promise<T | unknown> {
  try {
    return await action();
  } catch (error) {
    return sendLlamaError(reply, error, code);
  }
}

function validateEditableParams(
  params: Record<string, string>,
  reservedKeys: Set<string> = new Set(),
): {code: string; message: string} | null {
  const seen = new Set<string>();
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim();
    const normalized = key.toLowerCase();
    if (!key) {
      return {code: 'invalid_model_param', message: 'Parameter keys cannot be empty.'};
    }
    if (/[[\]=\r\n]/.test(key)) {
      return {
        code: 'invalid_model_param',
        message: `Parameter key "${key}" cannot contain brackets, equals signs, or newlines.`,
      };
    }
    if (reservedKeys.has(normalized)) {
      return {
        code: 'reserved_model_param',
        message: `Set "${key}" through the dedicated model field instead of params.`,
      };
    }
    if (seen.has(normalized)) {
      return {code: 'duplicate_model_param', message: `Duplicate parameter key: ${key}`};
    }
    seen.add(normalized);
    if (/[\r\n]/.test(rawValue)) {
      return {
        code: 'invalid_model_param',
        message: `Parameter "${key}" cannot contain newline characters.`,
      };
    }
  }
  return null;
}

/** The first issue names the problem; the rest are usually consequences of it. */
function nelleErrorFromZod(error: ZodError): NelleError {
  const issue = error.issues[0];
  const field = issue?.path.join('.') ?? '';
  return {
    code: NELLE_ERROR_CODES.invalidRequest,
    message: issue?.message ?? 'The request body was not valid.',
    detail:
      [field || undefined, error.issues.length > 1 ? `${error.issues.length} problems` : undefined]
        .filter(Boolean)
        .join(' — ') || undefined,
    retryable: false,
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
    input.modelCache.upsertModelProps(
      input.modelId,
      await input.llama.getModelProps(input.modelId),
    );
  } catch (error) {
    // A model that will not describe itself can still answer a prompt. Losing the
    // cache entry costs a capability, not the run.
    input.log.warn({err: error, modelId: input.modelId}, 'could not cache model props after load');
  }
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
function assertSupportedAttachments(
  attachments: ChatAttachmentInput[],
  modelCache: ModelCacheRepository,
  state: AppState,
): void {
  const hasImage = attachments.some(attachment => attachment.kind === 'image');
  if (!hasImage || !state.activeModelId) {
    return;
  }
  if (modelCache.getVisionSupport(state.activeModelId) !== false) {
    return;
  }
  const error = new Error(
    'The selected model cannot read images. Choose a vision model, or remove the image attachments.',
  );
  Object.assign(error, {code: NELLE_ERROR_CODES.unsupportedAttachment, retryable: false});
  throw error;
}

function formatMebibytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

/** Multipart text fields arrive as objects, or arrays when repeated. */
function fieldValue(field: unknown): string | undefined {
  const first = Array.isArray(field) ? field[0] : field;
  const value = (first as {value?: unknown} | undefined)?.value;
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

function sendLlamaError(
  reply: {status: (statusCode: number) => {send: (payload: unknown) => unknown}},
  error: unknown,
  code = 'llama_router_request_failed',
): unknown {
  return reply.status(502).send({
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    },
  });
}

function archiveBodyToBytes(body: unknown): Uint8Array | null {
  if (body instanceof Buffer) {
    return new Uint8Array(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  return null;
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
