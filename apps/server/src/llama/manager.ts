import fsSync from 'node:fs';

import type {AppPaths} from '../lib/paths';
import type {SettingsRepository} from '../settings/repository';
import {runtimeLimitsFromSettings, type RuntimeLimits} from '../contracts/settings.ts';
import {RUNTIME_SETTINGS_SLUG} from '../contracts/settingsKeys.ts';
import type {
  ConfiguredModel,
  LlamaAbortVerificationResult,
  LlamaModelProps,
  LlamaRouterModel,
  LlamaRouterProps,
  LlamaTokenizeResult,
  RuntimeStatus,
} from '../lib/types';
import {AppStore} from '../models/store';
import type {CommandOutputLine} from '../lib/process';
import type {RuntimeLogTail} from '../contracts/runtime.ts';
import {LlamaInstall} from './install.ts';
import {LlamaModelLoader, type EnsureModelRunnableOptions} from './load.ts';
import {removeModelSection, writePreset} from './preset.ts';
import {LlamaProcess} from './process.ts';
import {LlamaRouterClient} from './router.ts';

/**
 * llama.cpp, as Nelle sees it: install it, launch it, ask it things, and get a model loaded
 * before a run needs it. Four clusters that share almost nothing, behind one facade -- six test
 * files construct this class directly and the server holds exactly one of it, so the split is
 * internal and stays invisible to both.
 *
 * What is left *here* is what the four have in common, and it is only two things: `getStatus()`,
 * the hub that reads across the install and the process, and the `#lastError` it reports.
 */
export class LlamaCppManager {
  /**
   * Why llama-server is not running, when it should be. **The manager's, and it stays here**:
   * `getStatus()` is the hub that reports it, and every collaborator that can fail writes
   * through to it rather than keeping a second copy nobody would read.
   */
  #lastError: string | null = null;

  /**
   * Everything Nelle asks the *running* router over HTTP. It touches none of the state above
   * -- no child, no pid, no install -- which is what let it move out; `getStatus` is handed to
   * it as a callback because it reads two of them.
   */
  readonly #router: LlamaRouterClient;

  /**
   * Getting a model runnable before a run starts. It touches none of the state above either --
   * it is the router client, `models.ini` and a poll loop -- which is why it took nothing with it
   * when it left.
   */
  readonly #loader: LlamaModelLoader;

  /**
   * The llama-server child, its pid file, and the in-flight start. The only thing here that owns
   * an OS process -- and the reason `#lastError` has a setter: the child's exit is asynchronous,
   * so its death cannot be thrown at anybody.
   */
  readonly #process: LlamaProcess;

  /** The source build, the release download, and which version is on disk. */
  readonly #install: LlamaInstall;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    /**
     * How llama.cpp is launched (`--models-max`, `--sleep-idle-seconds`) is a settings
     * group now, not a corner of `state.json`. Optional so the preset tests can build a
     * manager without one; absent means the registry defaults, which is what a fresh
     * install would have anyway.
     */
    private readonly settings?: SettingsRepository,
  ) {
    const reportError = (message: string | null) => {
      this.#lastError = message;
    };
    this.#router = new LlamaRouterClient(paths, store, () => this.getStatus());
    this.#loader = new LlamaModelLoader(paths, store, this.#router);
    this.#install = new LlamaInstall(paths, {
      status: checkLatest => this.getStatus(checkLatest),
      reportError,
    });
    this.#process = new LlamaProcess(paths, store, () => this.#limits(), {
      status: () => this.getStatus(),
      binaryPath: () => this.#install.getBinaryPath(),
      lastError: () => this.#lastError,
      reportError,
    });
  }

  /** The launch limits, from the settings group. */
  #limits(): RuntimeLimits {
    return runtimeLimitsFromSettings(this.settings?.tryGetGroup(RUNTIME_SETTINGS_SLUG) ?? {});
  }

  async getStatus(checkLatest = false): Promise<RuntimeStatus> {
    const state = await this.store.getState();
    const binaryPath = await this.#install.getBinaryPath();
    const installed = binaryPath != null && fsSync.existsSync(binaryPath);
    const installedVersion = await this.#install.getInstalledVersion();
    const latestVersion = checkLatest
      ? await this.#install.getLatestVersion().catch(() => null)
      : null;
    const managedPid = await this.#process.getManagedPid();
    const serverAlreadyReachable =
      managedPid == null &&
      (await this.#process.isServerHealthy(state.runtime.host, state.runtime.port, 300));

    return {
      platform: process.platform,
      arch: process.arch,
      dataDir: this.paths.dataDir,
      workspaceDir: this.paths.workspaceDir,
      // **`null` when nothing is installed, which is what the contract has always promised.**
      //
      // `getBinaryPath()` answers where llama-server *would* live -- it has to, because that is
      // where the installer writes it -- and it is never null. Reporting that raw meant
      // `binaryPath` was never null either, so the `?? 'Not installed'` fallback that *both*
      // clients wrote against this field was dead code, and a fresh install showed the path of a
      // binary that was not there. Found by the M9 coverage audit: no test had ever injected
      // `GET /api/runtime`.
      binaryPath: installed ? binaryPath : null,
      logPath: this.paths.llamaLogPath,
      installMode: process.env.LLAMA_SERVER_PATH
        ? 'external'
        : process.platform === 'linux'
          ? 'source-master'
          : 'github-release',
      installed,
      installedVersion,
      previousVersion: await this.#install.getPreviousVersion(),
      latestVersion,
      updateAvailable: Boolean(
        installedVersion && latestVersion && installedVersion !== latestVersion,
      ),
      running: managedPid != null || serverAlreadyReachable,
      pid: managedPid,
      host: state.runtime.host,
      port: state.runtime.port,
      ...this.#limits(),
      activeModelId: state.activeModelId,
      lastError: this.#lastError,
    };
  }

  async installOrUpdate(
    options: {onOutput?: (output: CommandOutputLine) => void; version?: string} = {},
  ): Promise<RuntimeStatus> {
    return this.#install.installOrUpdate(options);
  }

  /**
   * Deletes the installed llama.cpp — its binaries and, on Linux, the cloned source — leaving the
   * model catalog (`models.ini`) and downloaded weights untouched.
   *
   * The managed server is stopped **first**: you cannot sensibly delete the binary of a running
   * process, and a router left reachable but pointing at a deleted binary would fail its next
   * start. `stop()` is a safe no-op when nothing is running, and a no-op for an `external` binary
   * (which Nelle did not start), which `#install.uninstall()` then refuses.
   */
  async uninstall(): Promise<RuntimeStatus> {
    await this.stop();
    return this.#install.uninstall();
  }

  /** Where `llama-server` lives, whether or not anything is installed there. */
  async getServerBinaryPath(): Promise<string | null> {
    return this.#install.getBinaryPath();
  }

  async readLogTail(maxBytes = 80_000): Promise<RuntimeLogTail> {
    return this.#process.readLogTail(maxBytes);
  }

  async getRouterProps(): Promise<LlamaRouterProps> {
    return this.#router.getRouterProps();
  }

  async getModelProps(modelId: string): Promise<LlamaModelProps> {
    return this.#router.getModelProps(modelId);
  }

  async tokenize(
    content: string,
    input: {
      addSpecial?: boolean;
      parseSpecial?: boolean;
      withPieces?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<LlamaTokenizeResult> {
    return this.#router.tokenize(content, input);
  }

  async verifyAbortIdle(
    input: {modelId?: string; graceMs?: number; pollMs?: number} = {},
  ): Promise<LlamaAbortVerificationResult> {
    return this.#router.verifyAbortIdle(input);
  }

  async getRouterModels(input: {reload?: boolean} = {}): Promise<{
    models: LlamaRouterModel[];
    raw: unknown;
  }> {
    return this.#router.getRouterModels(input);
  }

  async loadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return this.#router.loadRouterModel(modelId);
  }

  async ensureModelRunnable(
    modelId: string,
    options: EnsureModelRunnableOptions = {},
  ): Promise<{loaded: boolean}> {
    return this.#loader.ensureModelRunnable(modelId, options);
  }

  async unloadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return this.#router.unloadRouterModel(modelId);
  }

  async fetchRouterStream(pathname: string, signal?: AbortSignal): Promise<Response> {
    return this.#router.fetchRouterStream(pathname, signal);
  }

  async start(): Promise<RuntimeStatus> {
    return this.#process.start();
  }

  async stop(): Promise<RuntimeStatus> {
    return this.#process.stop();
  }

  /**
   * The facade keeps this. Six test files construct `LlamaCppManager` directly and `writePreset`
   * alone appears at 22 call sites; the split is internal and must stay invisible to them.
   */
  async writePreset(activeModel?: ConfiguredModel): Promise<void> {
    return writePreset(this.paths, this.store, activeModel);
  }

  async removeModelSection(modelId: string): Promise<void> {
    return removeModelSection(this.paths, modelId);
  }
}
