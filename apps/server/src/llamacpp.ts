import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, type ChildProcess} from 'node:child_process';

import type {AppPaths} from './paths';
import type {
  ConfiguredModel,
  LlamaAbortVerificationResult,
  LlamaModelProps,
  LlamaRouterModel,
  LlamaRouterProps,
  LlamaTokenizeResult,
  RuntimeStatus,
} from './types';
import {AppStore} from './store';
import {llamaRuntimeModelId} from './modelCompat';
import {commandExists, runCommand} from './process';
import {NELLE_ERROR_CODES} from '../../../packages/shared/src/contracts.ts';
import {templateSupportsThinking} from '../../../packages/shared/src/reasoning.ts';
import {
  MODEL_LOAD_POLL_MS,
  MODEL_LOAD_TIMEOUT_MS,
  isRunnableRouterStatus,
} from '../../../packages/shared/src/router.ts';
import {
  getModelsIniSectionValues,
  listModelsIniSections,
  parseModelsIni,
  removeModelsIniKeys,
  removeModelsIniSection,
  upsertModelsIniValues,
  writeModelsIniAtomic,
} from '../../../packages/shared/src/modelsIni.ts';

const LLAMA_REPO = 'ggml-org/llama.cpp';
const LLAMA_REPO_URL = `https://github.com/${LLAMA_REPO}.git`;
const HELPER_BINS = ['llama-server', 'llama-cli', 'llama-bench'];

type GithubRelease = {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
};

type ManagedProcessRecord = {
  pid: number;
  binaryPath: string;
  args: string[];
  host: string;
  port: number;
  presetPath: string;
  startedAt: string;
};

type LlamaSlotSnapshot = {
  id?: number;
  id_task?: number;
  is_processing?: boolean;
  next_token?: Array<{
    has_next_token?: boolean;
    n_decoded?: number;
  }>;
};

export class LlamaCppManager {
  #process: ChildProcess | null = null;
  #managedPid: number | null = null;
  #startPromise: Promise<RuntimeStatus> | null = null;
  #lastError: string | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
  ) {}

  async getStatus(checkLatest = false): Promise<RuntimeStatus> {
    const state = await this.store.getState();
    const binaryPath = await this.getBinaryPath();
    const installed = binaryPath != null && fsSync.existsSync(binaryPath);
    const installedVersion = await this.getInstalledVersion();
    const latestVersion = checkLatest ? await this.getLatestVersion().catch(() => null) : null;
    const managedPid = await this.getManagedPid();
    const serverAlreadyReachable =
      managedPid == null &&
      (await this.isServerHealthy(state.runtime.host, state.runtime.port, 300));

    return {
      platform: process.platform,
      arch: process.arch,
      dataDir: this.paths.dataDir,
      binaryPath,
      logPath: this.paths.llamaLogPath,
      installMode: process.env.LLAMA_SERVER_PATH
        ? 'external'
        : process.platform === 'linux'
          ? 'source-master'
          : 'github-release',
      installed,
      installedVersion,
      latestVersion,
      updateAvailable: Boolean(
        installedVersion && latestVersion && installedVersion !== latestVersion,
      ),
      running: managedPid != null || serverAlreadyReachable,
      pid: managedPid,
      host: state.runtime.host,
      port: state.runtime.port,
      modelsMax: state.runtime.modelsMax,
      sleepIdleSeconds: state.runtime.sleepIdleSeconds,
      activeModelId: state.activeModelId,
      lastError: this.#lastError,
    };
  }

  async installOrUpdate(): Promise<RuntimeStatus> {
    this.#lastError = null;
    try {
      if (process.env.LLAMA_SERVER_PATH) {
        return this.getStatus(true);
      }
      if (process.platform === 'linux') {
        await this.buildLinuxFromMaster();
      } else {
        await this.installFromGithubRelease();
      }
      return this.getStatus(true);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async readLogTail(maxBytes = 80_000): Promise<{path: string; text: string}> {
    try {
      const stat = await fs.stat(this.paths.llamaLogPath);
      const start = Math.max(0, stat.size - maxBytes);
      const length = stat.size - start;
      const handle = await fs.open(this.paths.llamaLogPath, 'r');
      try {
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        return {path: this.paths.llamaLogPath, text: buffer.toString('utf8')};
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {path: this.paths.llamaLogPath, text: ''};
      }
      throw error;
    }
  }

  async getRouterProps(): Promise<LlamaRouterProps> {
    const raw = await this.fetchRouterJson('/props');
    return {
      role: stringOrNull(getProp(raw, 'role')),
      maxInstances: numberOrNull(getProp(raw, 'max_instances') ?? getProp(raw, 'maxInstances')),
      modelsAutoload: booleanOrNull(
        getProp(raw, 'models_autoload') ?? getProp(raw, 'modelsAutoload'),
      ),
      runtime: await this.getStatus(),
      raw,
    };
  }

  async getModelProps(modelId: string): Promise<LlamaModelProps> {
    const raw = await this.fetchRouterJson(
      `/props?model=${encodeURIComponent(modelId)}&autoload=false`,
    );
    const defaultGenerationSettings =
      getProp(raw, 'default_generation_settings') ?? getProp(raw, 'defaultGenerationSettings');
    const modalities = getProp(raw, 'modalities');
    const contextWindow =
      numberOrNull(getProp(defaultGenerationSettings, 'n_ctx')) ??
      numberOrNull(getProp(defaultGenerationSettings, 'nCtx')) ??
      numberOrNull(getProp(raw, 'n_ctx')) ??
      numberOrNull(getProp(raw, 'nCtx'));

    const chatTemplate = stringOrUndefined(
      getProp(raw, 'chat_template') ?? getProp(raw, 'chatTemplate'),
    );

    return {
      modelId,
      modalities: {
        vision: booleanOrFalse(getProp(modalities, 'vision') ?? getProp(raw, 'vision')),
        audio: booleanOrFalse(getProp(modalities, 'audio') ?? getProp(raw, 'audio')),
        video: booleanOrFalse(getProp(modalities, 'video') ?? getProp(raw, 'video')),
      },
      contextWindow: contextWindow ?? undefined,
      chatTemplate,
      // Whether a model can think is a property of its chat template, and only
      // llama.cpp has it. No template reported means unknown, not "cannot".
      canReason: chatTemplate == null ? null : templateSupportsThinking(chatTemplate),
      defaultGenerationSettings,
      raw,
    };
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
    const raw = await this.fetchRouterJson('/tokenize', {
      method: 'POST',
      body: {
        content,
        add_special: input.addSpecial ?? false,
        parse_special: input.parseSpecial ?? true,
        with_pieces: input.withPieces ?? false,
      },
      signal: input.signal,
    });
    const tokens = getProp(raw, 'tokens');
    if (!Array.isArray(tokens)) {
      throw new Error('llama.cpp tokenize response did not include a tokens array.');
    }
    return {
      tokens: tokens.length,
      raw,
    };
  }

  async verifyAbortIdle(
    input: {modelId?: string; graceMs?: number; pollMs?: number} = {},
  ): Promise<LlamaAbortVerificationResult> {
    const graceMs = Math.max(0, input.graceMs ?? 5000);
    const pollMs = Math.min(Math.max(input.pollMs ?? 250, 50), 1000);
    const deadline = Date.now() + graceMs;
    let lastSlot: LlamaSlotSnapshot | null = null;

    for (;;) {
      const result = await this.fetchProcessingSlot(input.modelId);
      if (!result.checked) {
        return {checked: false, idle: true};
      }
      if (!result.slot) {
        return {checked: true, idle: true};
      }

      lastSlot = result.slot;
      if (Date.now() >= deadline) {
        const slotLabel = lastSlot.id == null ? 'unknown slot' : `slot ${lastSlot.id}`;
        const taskLabel = lastSlot.id_task == null ? '' : ` task ${lastSlot.id_task}`;
        return {
          checked: true,
          idle: false,
          warning: {
            code: 'llama_slot_still_processing',
            message:
              'llama.cpp still reports an active generation after stop. Open Settings > Runtime to stop or restart llama.cpp if it does not settle.',
            detail: `${input.modelId ?? 'selected model'} still has ${slotLabel}${taskLabel} processing after ${graceMs} ms.`,
            retryable: true,
          },
        };
      }

      await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  }

  async getRouterModels(input: {reload?: boolean} = {}): Promise<{
    models: LlamaRouterModel[];
    raw: unknown;
  }> {
    const raw = await this.fetchRouterJson(input.reload ? '/models?reload=1' : '/models');
    return {
      models: await this.mergeRouterModels(raw),
      raw,
    };
  }

  async loadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return {
      modelId,
      raw: await this.fetchRouterJson('/models/load', {
        method: 'POST',
        body: {model: modelId},
      }),
    };
  }

  /**
   * Makes a model runnable before a run starts, or explains why it cannot be.
   *
   * This state machine used to live in the browser, which meant every client had
   * to reimplement it: post a load, poll `/models`, watch for `failed`, give up
   * after 30 seconds. The semantics are preserved exactly, including the odd one:
   * a model the router does not list at all is left alone, and the request goes
   * through so llama.cpp can answer for itself.
   */
  async ensureModelRunnable(
    modelId: string,
    options: {
      onProgress?: (update: {status: string; progress?: number}) => void;
      timeoutMs?: number;
      pollMs?: number;
    } = {},
  ): Promise<{loaded: boolean}> {
    const pollMs = options.pollMs ?? MODEL_LOAD_POLL_MS;
    const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS) / pollMs));
    const find = (models: LlamaRouterModel[]) => models.find(model => model.sectionId === modelId);

    const current = find((await this.getRouterModels()).models);
    if (!current || isRunnableRouterStatus(current.status)) {
      return {loaded: false};
    }
    if (current.status !== 'loading') {
      await this.loadRouterModel(modelId);
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const next = find((await this.getRouterModels()).models);
      options.onProgress?.({status: next?.status ?? 'unknown', progress: next?.progress});
      if (isRunnableRouterStatus(next?.status)) {
        return {loaded: true};
      }
      if (next?.status === 'failed') {
        throw modelLoadError(modelLoadFailureMessage(modelId, next, this.paths.llamaLogPath), {
          logRef: this.paths.llamaLogPath,
        });
      }
      await delayMs(pollMs);
    }
    throw modelLoadError(`${modelId} did not finish loading before the router timed out.`);
  }

  async unloadRouterModel(modelId: string): Promise<{modelId: string; raw: unknown}> {
    return {
      modelId,
      raw: await this.fetchRouterJson('/models/unload', {
        method: 'POST',
        body: {model: modelId},
      }),
    };
  }

  async fetchRouterStream(pathname: string, signal?: AbortSignal): Promise<Response> {
    return this.fetchRouter(pathname, {signal});
  }

  async start(): Promise<RuntimeStatus> {
    if (this.#startPromise) {
      return this.#startPromise;
    }

    this.#startPromise = this.startInternal().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  private async startInternal(): Promise<RuntimeStatus> {
    this.#lastError = null;
    if (await this.getManagedPid()) {
      return this.getStatus();
    }

    const binaryPath = await this.getBinaryPath();
    if (!binaryPath || !fsSync.existsSync(binaryPath)) {
      throw new Error(
        'llama-server is not installed. Install or configure LLAMA_SERVER_PATH first.',
      );
    }

    const state = await this.store.getState();
    if (await this.isServerHealthy(state.runtime.host, state.runtime.port, 500)) {
      this.#lastError =
        'llama-server is already reachable on the configured port; Nelle did not start another process.';
      return this.getStatus();
    }

    await this.writePreset();
    await fs.mkdir(path.dirname(this.paths.llamaLogPath), {recursive: true});
    const log = fsSync.openSync(this.paths.llamaLogPath, 'a');
    let logClosed = false;
    const closeLog = () => {
      if (!logClosed) {
        logClosed = true;
        fsSync.closeSync(log);
      }
    };
    const args = [
      '--host',
      state.runtime.host,
      '--port',
      String(state.runtime.port),
      '--models-preset',
      this.paths.llamaPresetPath,
      '--models-max',
      String(state.runtime.modelsMax),
      '--sleep-idle-seconds',
      String(state.runtime.sleepIdleSeconds),
    ];

    const child = spawn(binaryPath, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    });

    this.#process = child;
    const childPid = child.pid;
    if (childPid) {
      this.#managedPid = childPid;
      await this.writePidFile({
        pid: childPid,
        binaryPath,
        args,
        host: state.runtime.host,
        port: state.runtime.port,
        presetPath: this.paths.llamaPresetPath,
        startedAt: new Date().toISOString(),
      });
    }
    child.once('exit', code => {
      this.#lastError = code === 0 ? null : `llama-server exited with code ${code}`;
      this.#process = null;
      if (this.#managedPid === childPid) {
        this.#managedPid = null;
      }
      if (childPid) {
        void this.clearPidFile(childPid);
      }
      closeLog();
    });
    child.once('error', error => {
      this.#lastError = error.message;
      this.#process = null;
      if (this.#managedPid === childPid) {
        this.#managedPid = null;
      }
      if (childPid) {
        void this.clearPidFile(childPid);
      }
      closeLog();
    });

    await this.waitForHealth(state.runtime.host, state.runtime.port);
    return this.getStatus();
  }

  async stop(): Promise<RuntimeStatus> {
    const pid = await this.getManagedPid();
    if (!pid) {
      this.#process = null;
      this.#managedPid = null;
      await this.clearPidFile();
      return this.getStatus();
    }

    await terminateProcessTree(pid, 'SIGTERM');
    await waitForProcessExit(pid, 5_000);
    if (isProcessAlive(pid)) {
      await terminateProcessTree(pid, 'SIGKILL');
      await waitForProcessExit(pid, 2_000);
    }

    this.#process = null;
    this.#managedPid = null;
    await this.clearPidFile(pid);
    return this.getStatus();
  }

  async writePreset(_activeModel?: ConfiguredModel): Promise<void> {
    const state = await this.store.getState();
    const existing = await fs.readFile(this.paths.llamaPresetPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    let document = parseModelsIni(existing);
    document = upsertModelsIniValues(document, null, {version: 1});
    document = upsertModelsIniValues(document, '*', state.globalModelParams);

    for (const model of state.models) {
      document = upsertModelsIniValues(
        document,
        llamaRuntimeModelId(model),
        modelSourceValues(model),
      );
      document = removeModelsIniKeys(document, llamaRuntimeModelId(model), ['load-on-startup']);
    }

    await writeModelsIniAtomic(this.paths.llamaPresetPath, document);
  }

  async removeModelSection(modelId: string): Promise<void> {
    const existing = await fs.readFile(this.paths.llamaPresetPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const document = removeModelsIniSection(parseModelsIni(existing), modelId);
    await writeModelsIniAtomic(this.paths.llamaPresetPath, document);
  }

  private async mergeRouterModels(raw: unknown): Promise<LlamaRouterModel[]> {
    const configured = await this.readConfiguredModelSections();
    const routerModels = extractRouterModelRecords(raw);
    const bySection = new Map<string, LlamaRouterModel>();

    for (const configuredModel of configured) {
      bySection.set(configuredModel.sectionId, {
        sectionId: configuredModel.sectionId,
        alias: configuredModel.alias ?? configuredModel.hfRepo ?? configuredModel.sectionId,
        hfRepo: configuredModel.hfRepo,
        status: 'unloaded',
        aliases: [],
      });
    }

    for (const routerModel of routerModels) {
      const normalized = normalizeRouterModel(routerModel);
      const sectionId = findConfiguredSectionId(normalized, configured) ?? normalized.sectionId;
      const previous = bySection.get(sectionId);
      bySection.set(sectionId, {
        ...previous,
        ...normalized,
        sectionId,
        routerModelId: normalized.routerModelId ?? normalized.sectionId,
        alias: previous?.alias ?? normalized.alias,
        hfRepo: previous?.hfRepo ?? normalized.hfRepo,
        aliases: normalized.aliases,
      });
    }

    return Array.from(bySection.values()).sort((left, right) =>
      left.alias.localeCompare(right.alias),
    );
  }

  private async readConfiguredModelSections(): Promise<
    Array<{sectionId: string; alias?: string; hfRepo?: string}>
  > {
    const state = await this.store.getState();
    const sections = new Map<string, {sectionId: string; alias?: string; hfRepo?: string}>();
    for (const model of state.models) {
      sections.set(llamaRuntimeModelId(model), {
        sectionId: llamaRuntimeModelId(model),
        alias: model.name,
        hfRepo: model.hfRef,
      });
    }

    const existing = await fs.readFile(this.paths.llamaPresetPath, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    });
    const document = parseModelsIni(existing);
    for (const sectionId of listModelsIniSections(document)) {
      if (sectionId === '*') {
        continue;
      }
      const values = getModelsIniSectionValues(document, sectionId);
      sections.set(sectionId, {
        sectionId,
        alias: values.get('alias') ?? sections.get(sectionId)?.alias,
        hfRepo: values.get('hf-repo') ?? sections.get(sectionId)?.hfRepo,
      });
    }

    return Array.from(sections.values());
  }

  private async fetchRouterJson(
    pathname: string,
    input: {method?: string; body?: unknown; signal?: AbortSignal} = {},
  ): Promise<unknown> {
    const response = await this.fetchRouter(pathname, {
      method: input.method,
      body: input.body,
      signal: input.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || `llama.cpp router request failed: ${response.status}`);
    }
    if (!text) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async fetchRouter(
    pathname: string,
    input: {method?: string; body?: unknown; signal?: AbortSignal} = {},
  ): Promise<Response> {
    const state = await this.store.getState();
    const url = new URL(`http://${state.runtime.host}:${state.runtime.port}${pathname}`);
    const response = await fetch(url, {
      method: input.method ?? 'GET',
      headers: input.body == null ? undefined : {'content-type': 'application/json'},
      body: input.body == null ? undefined : JSON.stringify(input.body),
      signal: input.signal,
    });
    return response;
  }

  private async fetchProcessingSlot(
    modelId?: string,
  ): Promise<{checked: boolean; slot: LlamaSlotSnapshot | null}> {
    const pathname = modelId ? `/slots?model=${encodeURIComponent(modelId)}` : '/slots';
    try {
      const response = await this.fetchRouter(pathname);
      if (response.status === 404 || response.status === 405) {
        return {checked: false, slot: null};
      }
      if (!response.ok) {
        return {checked: false, slot: null};
      }
      const slots = (await response.json()) as unknown;
      if (!Array.isArray(slots)) {
        return {checked: false, slot: null};
      }
      return {
        checked: true,
        slot: findProcessingSlot(slots),
      };
    } catch {
      return {checked: false, slot: null};
    }
  }

  private async buildLinuxFromMaster(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('Linux source builds can only run on Linux hosts.');
    }

    for (const command of ['git', 'cmake', 'make', 'gcc', 'g++']) {
      if (!(await commandExists(command))) {
        throw new Error(`Missing build dependency: ${command}`);
      }
    }

    await fs.mkdir(this.paths.llamaDir, {recursive: true});
    if (!fsSync.existsSync(path.join(this.paths.llamaSrcDir, '.git'))) {
      await runCommand('git', ['clone', '--depth', '1', LLAMA_REPO_URL, this.paths.llamaSrcDir]);
    } else {
      await runCommand('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], {
        cwd: this.paths.llamaSrcDir,
      });
      await runCommand('git', ['reset', '--hard', 'FETCH_HEAD'], {
        cwd: this.paths.llamaSrcDir,
      });
    }

    const buildDir = path.join(this.paths.llamaSrcDir, 'build');
    await fs.rm(buildDir, {recursive: true, force: true});

    const cmakeArgs = [
      '-S',
      this.paths.llamaSrcDir,
      '-B',
      buildDir,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DLLAMA_OPENSSL=ON',
      '-DLLAMA_BUILD_TESTS=OFF',
    ];

    if (await this.hasCudaToolchain()) {
      cmakeArgs.push('-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=native');
    }

    await runCommand('cmake', cmakeArgs);
    await runCommand('cmake', [
      '--build',
      buildDir,
      '--config',
      'Release',
      `-j${os.cpus().length}`,
      '--target',
      ...HELPER_BINS,
    ]);

    await fs.mkdir(this.paths.llamaBinDir, {recursive: true});
    for (const bin of HELPER_BINS) {
      const src = path.join(buildDir, 'bin', bin);
      await fs.copyFile(src, path.join(this.paths.llamaBinDir, bin));
      await fs.chmod(path.join(this.paths.llamaBinDir, bin), 0o755);
    }

    await this.copySharedLibraries(buildDir);
    const commit = await runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: this.paths.llamaSrcDir,
    });
    await fs.writeFile(path.join(this.paths.llamaBinDir, '.built-commit'), `${commit}\n`);
  }

  private async installFromGithubRelease(): Promise<void> {
    const release = await this.getLatestRelease();
    const asset = pickReleaseAsset(release, process.platform, process.arch);
    if (!asset) {
      throw new Error(`No llama.cpp release asset matched ${process.platform}/${process.arch}.`);
    }

    await fs.mkdir(this.paths.downloadsDir, {recursive: true});
    const archivePath = path.join(this.paths.downloadsDir, asset.name);
    const response = await fetch(asset.browser_download_url);
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${asset.name}: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await fs.writeFile(archivePath, bytes);

    const extractDir = path.join(this.paths.downloadsDir, `extract-${Date.now()}`);
    await fs.mkdir(extractDir, {recursive: true});
    if (asset.name.endsWith('.zip')) {
      if (process.platform === 'win32') {
        await runCommand('powershell.exe', [
          '-NoProfile',
          '-Command',
          `Expand-Archive -Force ${JSON.stringify(archivePath)} ${JSON.stringify(extractDir)}`,
        ]);
      } else {
        await runCommand('unzip', ['-q', archivePath, '-d', extractDir]);
      }
    } else {
      await runCommand('tar', ['-xzf', archivePath, '-C', extractDir]);
    }

    await fs.rm(this.paths.llamaBinDir, {recursive: true, force: true});
    await fs.mkdir(this.paths.llamaBinDir, {recursive: true});
    const server = await findFile(extractDir, binaryName('llama-server'));
    if (!server) {
      throw new Error(`llama-server was not found in ${asset.name}`);
    }
    await fs.cp(path.dirname(server), this.paths.llamaBinDir, {recursive: true});
    const libDir = path.join(path.dirname(path.dirname(server)), 'lib');
    if (fsSync.existsSync(libDir)) {
      await fs.cp(libDir, this.paths.llamaBinDir, {recursive: true});
    }
    await fs.writeFile(path.join(this.paths.llamaBinDir, '.release-tag'), `${release.tag_name}\n`);
  }

  /** Where `llama-server` lives, whether or not anything is installed there. */
  async getServerBinaryPath(): Promise<string | null> {
    return this.getBinaryPath();
  }

  private async getBinaryPath(): Promise<string | null> {
    const external = process.env.LLAMA_SERVER_PATH;
    if (external) {
      return path.resolve(external);
    }
    return path.join(this.paths.llamaBinDir, binaryName('llama-server'));
  }

  private async getManagedPid(): Promise<number | null> {
    if (this.#process?.pid && isProcessAlive(this.#process.pid)) {
      this.#managedPid = this.#process.pid;
      return this.#process.pid;
    }

    if (this.#managedPid && isProcessAlive(this.#managedPid)) {
      return this.#managedPid;
    }

    const record = await this.readPidFile();
    if (record) {
      if (await this.isManagedProcess(record)) {
        this.#managedPid = record.pid;
        return record.pid;
      }
      await this.clearPidFile(record.pid);
    }

    const discoveredPid = await this.findManagedPidByCommand();
    if (discoveredPid != null) {
      this.#managedPid = discoveredPid;
      return discoveredPid;
    }

    this.#managedPid = null;
    return null;
  }

  private async readPidFile(): Promise<ManagedProcessRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.paths.llamaPidPath, 'utf8')) as ManagedProcessRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.clearPidFile();
      }
      return null;
    }
  }

  private async writePidFile(record: ManagedProcessRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.paths.llamaPidPath), {recursive: true});
    await fs.writeFile(this.paths.llamaPidPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  private async clearPidFile(pid?: number): Promise<void> {
    if (pid != null) {
      const record = await this.readPidFile().catch(() => null);
      if (record && record.pid !== pid) {
        return;
      }
    }
    await fs.rm(this.paths.llamaPidPath, {force: true});
  }

  private async isManagedProcess(record: ManagedProcessRecord): Promise<boolean> {
    if (!isProcessAlive(record.pid)) {
      return false;
    }

    const commandLine = await getProcessCommandLine(record.pid);
    if (!commandLine) {
      return false;
    }

    return (
      commandLine.includes(path.basename(record.binaryPath)) &&
      commandLine.includes(record.presetPath)
    );
  }

  private async findManagedPidByCommand(): Promise<number | null> {
    if (process.platform === 'win32') {
      return null;
    }

    const output = await runCommand('ps', ['-eo', 'pid=,args=']).catch(() => '');
    const state = await this.store.getState();
    const binaryPath = (await this.getBinaryPath()) ?? 'llama-server';
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      const commandLine = match[2];
      if (
        Number.isInteger(pid) &&
        commandLine.includes('llama-server') &&
        commandLine.includes(this.paths.llamaPresetPath)
      ) {
        await this.writePidFile({
          pid,
          binaryPath,
          args: commandLine.split(/\s+/).slice(1),
          host: state.runtime.host,
          port: state.runtime.port,
          presetPath: this.paths.llamaPresetPath,
          startedAt: new Date().toISOString(),
        });
        return pid;
      }
    }
    return null;
  }

  private async isServerHealthy(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`http://${host}:${port}/v1/models`, {
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getInstalledVersion(): Promise<string | null> {
    const external = process.env.LLAMA_SERVER_PATH;
    if (external) {
      return `external:${external}`;
    }
    const commitPath = path.join(this.paths.llamaBinDir, '.built-commit');
    const tagPath = path.join(this.paths.llamaBinDir, '.release-tag');
    try {
      return (await fs.readFile(commitPath, 'utf8')).trim();
    } catch {}
    try {
      return (await fs.readFile(tagPath, 'utf8')).trim();
    } catch {}
    return null;
  }

  private async getLatestVersion(): Promise<string | null> {
    if (process.env.LLAMA_SERVER_PATH) {
      return null;
    }
    if (process.platform === 'linux') {
      return runCommand('git', ['ls-remote', LLAMA_REPO_URL, 'HEAD']).then(
        line => line.split(/\s+/)[0] ?? null,
      );
    }
    return this.getLatestRelease().then(release => release.tag_name);
  }

  private async getLatestRelease(): Promise<GithubRelease> {
    const response = await fetch(`https://api.github.com/repos/${LLAMA_REPO}/releases/latest`, {
      headers: {'user-agent': 'nelle-server'},
    });
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed: ${response.status}`);
    }
    return (await response.json()) as GithubRelease;
  }

  private async hasCudaToolchain(): Promise<boolean> {
    return (await commandExists('nvidia-smi')) && (await commandExists('nvcc'));
  }

  private async copySharedLibraries(buildDir: string): Promise<void> {
    const names = await collectFiles(buildDir, file => /\.(so|dylib)(\..*)?$/.test(file));
    await Promise.all(
      names.map(file =>
        fs
          .copyFile(file, path.join(this.paths.llamaBinDir, path.basename(file)))
          .catch(() => undefined),
      ),
    );
  }

  private async waitForHealth(host: string, port: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    const url = `http://${host}:${port}/v1/models`;
    while (Date.now() < deadline) {
      if (await this.isServerHealthy(host, port, 750)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`llama-server did not become healthy at ${url}`);
  }
}

function binaryName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function terminateProcessTree(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') {
      args.push('/f');
    }
    await runCommand('taskkill', args).catch(() => undefined);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function getProcessCommandLine(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    try {
      const command = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      const normalized = command.split(String.fromCharCode(0)).join(' ').trim();
      if (normalized) {
        return normalized;
      }
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    return runCommand('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ]).catch(() => null);
  }

  return runCommand('ps', ['-p', String(pid), '-o', 'command=']).catch(() => null);
}

function pickReleaseAsset(
  release: GithubRelease,
  platform: NodeJS.Platform,
  arch: string,
): GithubRelease['assets'][number] | null {
  const names = release.assets.map(asset => asset.name.toLowerCase());
  const candidates =
    platform === 'darwin'
      ? arch === 'arm64'
        ? ['macos-arm64']
        : ['macos-x64', 'macos']
      : platform === 'win32'
        ? arch === 'x64'
          ? ['win-vulkan-x64', 'win-avx2-x64', 'win-x64']
          : ['win-arm64']
        : [];

  for (const needle of candidates) {
    const index = names.findIndex(name => name.includes(needle));
    if (index >= 0) {
      return release.assets[index];
    }
  }
  return null;
}

async function findFile(root: string, filename: string): Promise<string | null> {
  const files = await collectFiles(root, file => path.basename(file) === filename);
  return files[0] ?? null;
}

async function collectFiles(root: string, predicate: (file: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  const entries = await fs.readdir(root, {withFileTypes: true});
  await Promise.all(
    entries.map(async entry => {
      const fullPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        found.push(...(await collectFiles(fullPath, predicate)));
      } else if (entry.isFile() && predicate(fullPath)) {
        found.push(fullPath);
      }
    }),
  );
  return found;
}

function extractRouterModelRecords(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    return raw;
  }
  const data = getProp(raw, 'data');
  if (Array.isArray(data)) {
    return data;
  }
  const models = getProp(raw, 'models');
  if (Array.isArray(models)) {
    return models;
  }
  return [];
}

function normalizeRouterModel(raw: unknown): LlamaRouterModel {
  const id =
    stringOrUndefined(getProp(raw, 'id')) ??
    stringOrUndefined(getProp(raw, 'model')) ??
    stringOrUndefined(getProp(raw, 'name')) ??
    'unknown';
  const aliases = arrayOfStrings(getProp(raw, 'aliases'));
  const statusValue = getProp(getProp(raw, 'status'), 'value') ?? getProp(raw, 'status');

  return {
    sectionId: id,
    routerModelId: id,
    alias: aliases[0] ?? id,
    hfRepo:
      stringOrUndefined(getProp(raw, 'hf_repo')) ??
      stringOrUndefined(getProp(raw, 'hfRepo')) ??
      stringOrUndefined(getProp(raw, 'source')),
    status: stringOrUndefined(statusValue) ?? 'unknown',
    progress:
      numberOrNull(getProp(raw, 'progress')) ??
      numberOrNull(getProp(getProp(raw, 'status'), 'progress')) ??
      undefined,
    aliases,
    source: stringOrUndefined(getProp(raw, 'source')),
    canRemove: booleanOrNull(getProp(raw, 'can_remove') ?? getProp(raw, 'canRemove')) ?? undefined,
    architecture: stringOrUndefined(getProp(raw, 'architecture')),
    raw,
  };
}

function modelLoadError(message: string, extra: {logRef?: string} = {}): Error {
  const error = new Error(message);
  Object.assign(error, {code: NELLE_ERROR_CODES.modelLoadFailed, retryable: true, ...extra});
  return error;
}

/**
 * Nelle does not guess why a model would not load; llama.cpp already wrote it
 * down. The router reports the child's exit code, and the child's own stderr --
 * the line that actually says what went wrong -- is in the runtime log behind
 * its pid.
 *
 * Removing the context default made this legible-or-useless: a model that loaded
 * yesterday at 16k may not load today at its trained window, and "Check the
 * llama.cpp logs" neither says why nor opens them.
 */
export function modelLoadFailureMessage(
  modelId: string,
  model: {raw?: unknown},
  logPath: string,
): string {
  const exitCode = routerExitCode(model.raw);
  const exit = exitCode == null ? '' : ` (llama-server exited with code ${exitCode})`;
  return (
    `${modelId} failed to load${exit}. The reason is in ${logPath}. ` +
    'A model may not fit its trained context window: set `c` to a smaller size, quantise the KV ' +
    'cache with `ctk`/`ctv`, or move layers with `ngl`, `cmoe` or `ot` in Settings > Models.'
  );
}

function routerExitCode(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const status = (raw as {status?: unknown}).status;
  if (!status || typeof status !== 'object') {
    return null;
  }
  const exitCode = (status as {exit_code?: unknown}).exit_code;
  return typeof exitCode === 'number' ? exitCode : null;
}

function delayMs(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function findConfiguredSectionId(
  routerModel: LlamaRouterModel,
  configured: Array<{sectionId: string; hfRepo?: string}>,
): string | null {
  for (const item of configured) {
    if (
      item.sectionId === routerModel.sectionId ||
      item.sectionId === routerModel.routerModelId ||
      routerModel.aliases.includes(item.sectionId) ||
      (item.hfRepo != null && item.hfRepo === routerModel.hfRepo)
    ) {
      return item.sectionId;
    }
  }
  return null;
}

function findProcessingSlot(slots: unknown[]): LlamaSlotSnapshot | null {
  return (
    (slots.find(slot => {
      const item = slot as LlamaSlotSnapshot;
      return (
        item.is_processing === true ||
        item.next_token?.some(token => token.has_next_token === true) === true
      );
    }) as LlamaSlotSnapshot | undefined) ?? null
  );
}

function getProp(value: unknown, key: string): unknown {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function booleanOrFalse(value: unknown): boolean {
  return value === true;
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(item => typeof item === 'string');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function modelSourceValues(model: ConfiguredModel): Record<string, string> {
  if (model.hfRef) {
    return {
      'hf-repo': model.hfRef,
      alias: model.name || model.hfRef,
      'stop-timeout': '10',
      ...(model.params.extra ?? {}),
    };
  }
  throw new Error(`Model ${model.name} has no Hugging Face reference.`);
}
