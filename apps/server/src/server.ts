import path from 'node:path';

import {HuggingFaceService} from './models/huggingface';
import {LlamaCppManager} from './llama/manager';
import {registerLlamaProxy} from './llama/proxy';
import {PiHarness} from './pi/harness';
import {Router, applyCors, json, preflightResponse, type Ctx} from './http/router';
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
import {ModelCacheRepository} from './models/cache';
import {GgufMetadataRepository} from './models/gguf';
import {ConversationRepository} from './conversations/repository';
import {isPathWithin, resolveRelativeDataPath, sweepOrphanAttachmentFiles} from './lib/files';
import {createLogger} from './lib/logger';
import type {AppPaths} from './lib/paths';
import {pairRequestSchema, refreshRequestSchema, NELLE_ERROR_CODES} from './contracts/contracts.ts';
import {SETTINGS_REGISTRY, type SettingsGroup} from './contracts/settings.ts';
import {ALLOW_LAN_ACCESS_KEY, NETWORK_SETTINGS_SLUG} from './contracts/settingsKeys.ts';
import {LlamaOptionCatalogueCache} from './llama/params';
import {registerChatStreamRoute, registerRegenerateRoute} from './routes/chat';
import {registerConversationRoutes} from './routes/conversations';
import {registerUploadRoutes} from './routes/uploads';
import type {RouteDeps} from './routes/deps';
import {registerHealthRoutes} from './routes/health';
import {registerHuggingFaceRoutes} from './routes/huggingface';
import {registerLlamaRoutes} from './routes/llama';
import {registerModelRoutes} from './routes/models';
import {registerRuntimeRoutes} from './routes/runtime';
import {registerSettingsRoutes} from './routes/settings';

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

  registerChatStreamRoute(router, deps);

  registerUploadRoutes(router, deps);

  registerRegenerateRoute(router, deps);

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
