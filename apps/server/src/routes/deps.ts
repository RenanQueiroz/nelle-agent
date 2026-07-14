import type {UploadRepository} from '../attachments/uploads';
import type {DeviceRepository} from '../auth/devices';
import type {ServerCert} from '../auth/tls';
import type {ConversationRepository} from '../conversations/repository';
import type {Logger} from '../lib/logger';
import type {AppPaths} from '../lib/paths';
import type {LlamaCppManager} from '../llama/manager';
import type {LlamaOptionCatalogueCache} from '../llama/params';
import type {ModelCacheRepository} from '../models/cache';
import type {GgufMetadataRepository} from '../models/gguf';
import type {HuggingFaceService} from '../models/huggingface';
import type {AppStore} from '../models/store';
import type {HostToolRepository} from '../pi/hostTools';
import type {PiHarness} from '../pi/harness';
import type {PreferencesRepository} from '../settings/preferences';
import type {SettingsRepository} from '../settings/repository';

/**
 * Everything `createServer` constructs, handed to the route modules.
 *
 * One bag rather than a bespoke parameter list per module, on purpose: the alternative is
 * eleven signatures that drift, and a module that needs one more repository becomes a
 * change to `server.ts` and to itself. A route module takes what it needs off this and
 * ignores the rest.
 *
 * There is no `router` here. The router is passed separately, because *when* a module is
 * handed it is the whole point: registration order is match order.
 */
export type RouteDeps = {
  paths: AppPaths;
  store: AppStore;
  conversations: ConversationRepository;
  hostTools: HostToolRepository;
  preferences: PreferencesRepository;
  settings: SettingsRepository;
  modelCache: ModelCacheRepository;
  ggufMetadata: GgufMetadataRepository;
  uploads: UploadRepository;
  devices: DeviceRepository;
  llama: LlamaCppManager;
  llamaOptions: LlamaOptionCatalogueCache;
  hf: HuggingFaceService;
  pi: PiHarness;
  log: Logger;
  /** The self-signed TLS cert for the LAN listener, or `null` when LAN is off. */
  serverCert: ServerCert | null;
  tlsPort: number;
};
