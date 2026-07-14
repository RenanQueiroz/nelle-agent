import path from 'node:path';

import {z} from 'zod';

import {HuggingFaceService} from './models/huggingface';
import {LlamaCppManager} from './llama/manager';
import {registerLlamaProxy} from './llama/proxy';
import {PiHarness} from './pi/harness';
import {Router, applyCors, json, preflightResponse, type Ctx} from './http/router';
import {sseResponse, writeChatError, writeChatEvent, writeChatStream} from './http/sse';
import {AppStore} from './models/store';
import {AppDatabase} from './db/database';
import {HostToolRepository} from './pi/hostTools';
import {PreferencesRepository} from './settings/preferences';
import {SettingsRepository} from './settings/repository';
import {UPLOAD_SWEEP_INTERVAL_MS, UploadRepository} from './attachments/uploads';
import {DeviceRepository} from './auth/devices';
import {AUTH_ALLOWLIST, authorizeBearer} from './auth/auth';
import {buildPairingPayload} from './auth/pairing';
import {ensureServerCert, localIPv4s, type ServerCert} from './auth/tls';
import {buildOpenApiDocument} from './openapi';
import {
  ingestUpload,
  resolveChatAttachments,
  UnsupportedAttachmentError,
} from './attachments/ingest';
import {ATTACHMENT_LIMITS} from './contracts/attachments.ts';
import {ModelCacheRepository} from './models/cache';
import {GgufMetadataRepository} from './models/gguf';
import {effectiveContextWindow} from './llama/contextWindow';
import {ensureModelReadyForRun} from './llama/modelReady';
import {ConversationRepository} from './conversations/repository';
import {resolveConversationModel} from './conversations/model';
import {isPathWithin, resolveRelativeDataPath, sweepOrphanAttachmentFiles} from './lib/files';
import {createLogger} from './lib/logger';
import type {AppPaths} from './lib/paths';
import type {ChatAttachmentInput, ChatStreamEvent} from './lib/types';
import type {NelleError, UploadResponse} from './contracts/contracts.ts';
import {
  chatRequestSchema,
  pairRequestSchema,
  refreshRequestSchema,
  NELLE_ERROR_CODES,
} from './contracts/contracts.ts';
import {SETTINGS_REGISTRY, type SettingsGroup} from './contracts/settings.ts';
import {
  ALLOW_LAN_ACCESS_KEY,
  ATTACHMENTS_SETTINGS_SLUG,
  MAX_IMAGE_MEGAPIXELS_KEY,
  NETWORK_SETTINGS_SLUG,
} from './contracts/settingsKeys.ts';
import {LlamaOptionCatalogueCache} from './llama/params';
import {conversationNotFound, registerConversationRoutes} from './routes/conversations';
import type {RouteDeps} from './routes/deps';
import {
  assertRuntimeRunning,
  assertSupportedAttachments,
  assertSupportedSlashCommand,
} from './routes/guards';
import {registerHealthRoutes} from './routes/health';
import {registerHuggingFaceRoutes} from './routes/huggingface';
import {registerLlamaRoutes} from './routes/llama';
import {registerModelRoutes} from './routes/models';
import {registerRuntimeRoutes} from './routes/runtime';
import {registerSettingsRoutes} from './routes/settings';

const regenerateMessageSchema = z
  .object({
    modelId: z.string().min(1).optional(),
  })
  .optional();

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

  const deps: RouteDeps = {
    paths,
    store,
    conversations,
    hostTools,
    preferences,
    settings,
    modelCache,
    ggufMetadata,
    uploads,
    devices,
    llama,
    llamaOptions,
    hf,
    pi,
    log,
    serverCert,
    tlsPort,
  };

  /**
   * **The order of these calls is the router's match order**, and `Router.dispatch` matches in
   * insertion order with `:id` compiled to `([^/]+)`. So a literal path segment must be
   * registered before any `:param` route that would swallow it -- `PATCH /api/models/global-params`
   * before `PATCH /api/models/:id`, which is the one such pair in the table. It is also the path
   * order of the served OpenAPI document.
   */
  const router = new Router();
  registerLlamaProxy(router, store);
  registerHealthRoutes(router, deps);
  registerSettingsRoutes(router, deps);
  registerRuntimeRoutes(router, deps);
  registerLlamaRoutes(router, deps);
  registerModelRoutes(router, deps);
  registerHuggingFaceRoutes(router, deps);
  registerConversationRoutes(router, deps);

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

        const stream = await createChatStream({
          pi,
          conversationId: id,
          message: body.message,
          attachments: resolved.attachments,
        });
        await writeChatStream(sink, stream, id);
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
    // **Nelle serves no web app.** It is an API server: every client is a native one that
    // speaks the served REST + SSE contract (`GET /api/openapi.json`). An unmatched path is
    // a 404, not an `index.html` -- there is no SPA to fall back to.
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

/**
 * The chat stream. **Pi is the only path.**
 *
 * There used to be a "direct llama.cpp fallback" here, and it was not one: it ran only when
 * `NELLE_PI_DISABLED=1` (an env var nothing in the server or the scripts ever set -- only a test)
 * *and* the conversation was `legacy-default`, which only the retired migration ever created. It was
 * unreachable in production, untested end to end, and supported no tools, no reasoning, no
 * compaction and no regenerate. `README` promised it as a real capability; that sentence was false.
 *
 * A Pi failure surfaces as a coded stream error the client renders. That **is** the graceful
 * degradation. A second, permanently second-class chat engine that never runs is not a safety net --
 * it is the least-tested code in the repository, waiting to execute at the worst possible moment.
 */
async function createChatStream(input: {
  pi: PiHarness;
  conversationId: string;
  message: string;
  attachments: ChatAttachmentInput[];
}): Promise<AsyncIterable<ChatStreamEvent>> {
  return input.pi.streamPrompt(input.message, input.conversationId, input.attachments);
}

/** A numeric attachment setting, or `undefined` when the registry lacks the group. */
function attachmentSetting(settings: SettingsRepository, key: string): number | undefined {
  const value = settings.tryGetGroup(ATTACHMENTS_SETTINGS_SLUG)?.[key];
  return typeof value === 'number' ? value : undefined;
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
