import fs from 'node:fs/promises';

import {HuggingFaceService} from './models/huggingface';
import {LlamaCppManager} from './llama/manager';
import {registerLlamaProxy} from './llama/proxy';
import {PiHarness} from './pi/harness';
import {Router, applyCors, json, preflightResponse} from './http/router';
import {NELLE_ERROR_CODES} from './contracts/contracts.ts';
import {sweepOrphanAttachmentFiles} from './lib/files';
import {AppStore} from './models/store';
import {AppDatabase} from './db/database';
import {HostToolRepository} from './pi/hostTools';
import {PreferencesRepository} from './settings/preferences';
import {SettingsRepository} from './settings/repository';
import {UPLOAD_SWEEP_INTERVAL_MS, UploadRepository} from './attachments/uploads';
import {DeviceRepository} from './auth/devices';
import {AUTH_ALLOWLIST, authorizeBearer} from './auth/auth';
import {ensureServerCert, type ServerCert} from './auth/tls';
import {buildOpenApiDocument} from './openapi';
import {ModelCacheRepository} from './models/cache';
import {GgufMetadataRepository} from './models/gguf';
import {ConversationRepository} from './conversations/repository';
import {createLogger} from './lib/logger';
import type {AppPaths} from './lib/paths';
import {SETTINGS_REGISTRY, type SettingsGroup} from './contracts/settings.ts';
import {ALLOW_LAN_ACCESS_KEY, NETWORK_SETTINGS_SLUG} from './contracts/settingsKeys.ts';
import {LlamaOptionCatalogueCache} from './llama/params';
import {registerAttachmentRoutes} from './routes/attachments';
import {registerAuthRoutes} from './routes/auth';
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
  // On a fresh install the data dir (default `~/.nelle`) does not exist yet, and the settings db
  // and every repository below opens files under it -- `bun:sqlite` creates the file but not its
  // parent. The workspace (default the user's home) normally exists, but a custom
  // `NELLE_WORKSPACE_DIR` may not. Create both before anything reads them.
  await fs.mkdir(paths.dataDir, {recursive: true});
  await fs.mkdir(paths.workspaceDir, {recursive: true});
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
  // Chat and regenerate are one module and two calls, because the uploads routes have always
  // sat between them. Keeping that is what makes the route table -- and the path order of the
  // document below -- identical to what it was before any of this moved.
  registerChatStreamRoute(router, deps);
  registerUploadRoutes(router, deps);
  registerRegenerateRoute(router, deps);
  registerAttachmentRoutes(router, deps);
  registerAuthRoutes(router, deps);

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
    //
    // **It runs here, before `dispatch`, and it stays here.** An unauthenticated LAN request
    // gets 401 whether or not the route exists, so the gate leaks nothing about the route
    // table -- and no route module can forget to apply it, because none of them can.
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
