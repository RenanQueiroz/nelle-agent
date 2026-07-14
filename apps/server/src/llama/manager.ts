import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
import {
  commandExists,
  runCommand,
  runCommandStreaming,
  type CommandOutputLine,
} from '../lib/process';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import type {RuntimeLogTail} from '../contracts/runtime.ts';
import {LlamaModelLoader} from './load.ts';
import {removeModelSection, writePreset} from './preset.ts';
import {LlamaRouterClient} from './router.ts';

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

export class LlamaCppManager {
  #process: Bun.Subprocess | null = null;
  #managedPid: number | null = null;
  #startPromise: Promise<RuntimeStatus> | null = null;
  #lastError: string | null = null;
  /**
   * A source build takes minutes and the button shows nothing, so a second click is not an
   * exotic race -- it is the obvious thing to do. Two concurrent builds would fight over
   * the same `build/` directory, which `buildLinuxFromMaster` starts by `rm -rf`-ing.
   */
  #installing = false;

  /**
   * Everything Nelle asks the *running* router over HTTP. It touches none of the fields above
   * -- no child, no pid, no install -- which is what let it move out; `getStatus` is handed to
   * it as a callback because it reads two of them.
   */
  readonly #router: LlamaRouterClient;

  /**
   * Getting a model runnable before a run starts. It touches none of the fields above either --
   * it is the router client, `models.ini` and a poll loop -- which is why it took nothing with it
   * when it left.
   */
  readonly #loader: LlamaModelLoader;

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
    this.#router = new LlamaRouterClient(paths, store, () => this.getStatus());
    this.#loader = new LlamaModelLoader(paths, store, this.#router);
  }

  /** The launch limits, from the settings group. */
  #limits(): RuntimeLimits {
    return runtimeLimitsFromSettings(this.settings?.tryGetGroup(RUNTIME_SETTINGS_SLUG) ?? {});
  }

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

  /**
   * `onOutput` receives the build's own output as it happens. Absent, the install is silent
   * -- which is what the non-streaming route still does, and why it needed replacing.
   */
  async installOrUpdate(
    options: {onOutput?: (output: CommandOutputLine) => void} = {},
  ): Promise<RuntimeStatus> {
    if (this.#installing) {
      throw installInProgressError();
    }
    this.#installing = true;
    this.#lastError = null;
    try {
      if (process.env.LLAMA_SERVER_PATH) {
        // `external`: the binary is the user's, so there is nothing to build.
        return await this.getStatus(true);
      }
      if (process.platform === 'linux') {
        await this.buildLinuxFromMaster(options.onOutput);
      } else {
        await this.installFromGithubRelease(options.onOutput);
      }
      return await this.getStatus(true);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.#installing = false;
    }
  }

  /**
   * Why llama-server died, in its own words.
   *
   * `llama-server exited with code 1` is true and useless. The reason is already written down —
   * a single mistyped key in `models.ini` produces
   * `option 'not-a-real-key' not recognized in preset '<section>'`, which names the key *and*
   * the section — and Nelle is holding the log. Making the user go and find it is a choice, and
   * the wrong one.
   *
   * The last `E` line only counts **because the process exited non-zero**. An `E` on its own is
   * not a failure: a *successful* offline load of a pinned model logs
   * `E get_repo_commit: error: GET failed (404)` every single time, which is the cache fallback
   * working as designed. The exit code is what makes this line the reason.
   */
  private async describeExit(exitCode: number): Promise<string> {
    const fallback = `llama-server exited with code ${exitCode}`;
    try {
      const {text} = await this.readLogTail(16_000);
      const lastError = text
        .split('\n')
        .filter(line => / E [a-z]/i.test(line) || /\bE\s+srv\b/.test(line))
        .at(-1);
      if (!lastError) {
        return fallback;
      }
      // Strip llama.cpp's timestamp/level prefix; keep the sentence.
      const message = lastError.replace(/^[\d.]+\s+E\s+\S+\s*/, '').trim();
      return message ? `${fallback}: ${message}` : fallback;
    } catch {
      return fallback;
    }
  }

  async readLogTail(maxBytes = 80_000): Promise<RuntimeLogTail> {
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
    options: {
      onProgress?: (update: {status: string; progress?: number}) => void;
      timeoutMs?: number;
      pollMs?: number;
    } = {},
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
        try {
          fsSync.closeSync(log);
        } catch {
          // The fd may already be gone; closing twice is not an error worth raising.
        }
      }
    };
    const limits = this.#limits();
    const args = [
      '--host',
      state.runtime.host,
      '--port',
      String(state.runtime.port),
      '--models-preset',
      this.paths.llamaPresetPath,
      '--models-max',
      String(limits.modelsMax),
      '--sleep-idle-seconds',
      String(limits.sleepIdleSeconds),
    ];

    await fs.mkdir(this.paths.modelsDir, {recursive: true});

    let child: Bun.Subprocess;
    try {
      child = Bun.spawn([binaryPath, ...args], {
        // `Bun.spawn` does not inherit the parent env by default the way
        // `node:child_process` does, and llama-server needs it (PATH for shared
        // libs, `LLAMA_ARG_OFFLINE`, CUDA_VISIBLE_DEVICES, ...).
        env: {...process.env, ...modelCacheEnv(this.paths.modelsDir)},
        // POSIX: `setsid()`, so the child leads a new process group Nelle can kill
        // with `process.kill(-pid)`. Windows: `UV_PROCESS_DETACHED`. Both let the
        // llama-server outlive a nelle-server restart, so a new one can adopt it.
        detached: process.platform !== 'win32',
        stdin: 'ignore',
        // Both streams append to the shared log fd, as `stdio: ['ignore', log, log]`
        // did under `node:child_process`.
        stdout: log,
        stderr: log,
      });
    } catch (error) {
      // `Bun.spawn` throws synchronously when the binary is missing or not
      // executable, where `node:child_process` emitted an async `error` event.
      closeLog();
      this.#process = null;
      this.#lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }

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
    void (async () => {
      const exitCode = await child.exited;
      this.#lastError = exitCode === 0 ? null : await this.describeExit(exitCode);
      this.#process = null;
      if (this.#managedPid === childPid) {
        this.#managedPid = null;
      }
      if (childPid) {
        void this.clearPidFile(childPid);
      }
      closeLog();
    })();

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

  private async buildLinuxFromMaster(
    onOutput?: (output: CommandOutputLine) => void,
  ): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('Linux source builds can only run on Linux hosts.');
    }

    // Echo the command before running it. Ten minutes of raw cmake output with no idea
    // which step you are on is barely better than no output at all.
    const run = (command: string, args: string[], options: {cwd?: string} = {}) => {
      onOutput?.({stream: 'stdout', line: `$ ${command} ${args.join(' ')}`});
      return runCommandStreaming(command, args, {...options, onLine: onOutput});
    };

    for (const command of ['git', 'cmake', 'make', 'gcc', 'g++']) {
      if (!(await commandExists(command))) {
        throw new Error(`Missing build dependency: ${command}`);
      }
    }

    await fs.mkdir(this.paths.llamaDir, {recursive: true});
    if (!fsSync.existsSync(path.join(this.paths.llamaSrcDir, '.git'))) {
      await run('git', ['clone', '--depth', '1', LLAMA_REPO_URL, this.paths.llamaSrcDir]);
    } else {
      await run('git', ['fetch', '--depth', '1', 'origin', 'HEAD'], {
        cwd: this.paths.llamaSrcDir,
      });
      await run('git', ['reset', '--hard', 'FETCH_HEAD'], {
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

    await run('cmake', cmakeArgs);
    await run('cmake', [
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
      await replaceRunningFile(src, path.join(this.paths.llamaBinDir, bin));
      await fs.chmod(path.join(this.paths.llamaBinDir, bin), 0o755);
    }

    await this.copySharedLibraries(buildDir);
    const commit = await runCommand('git', ['rev-parse', 'HEAD'], {
      cwd: this.paths.llamaSrcDir,
    });
    await fs.writeFile(path.join(this.paths.llamaBinDir, '.built-commit'), `${commit}\n`);
  }

  private async installFromGithubRelease(
    onOutput?: (output: CommandOutputLine) => void,
  ): Promise<void> {
    const say = (line: string) => onOutput?.({stream: 'stdout', line});

    const release = await this.getLatestRelease();
    const asset = pickReleaseAsset(release, process.platform, process.arch);
    if (!asset) {
      throw new Error(`No llama.cpp release asset matched ${process.platform}/${process.arch}.`);
    }

    await fs.mkdir(this.paths.downloadsDir, {recursive: true});
    const archivePath = path.join(this.paths.downloadsDir, asset.name);
    say(`Downloading ${asset.name} (${release.tag_name})`);
    const response = await fetch(asset.browser_download_url);
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${asset.name}: ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await fs.writeFile(archivePath, bytes);
    say(`Downloaded ${(bytes.byteLength / 1_000_000).toFixed(1)} MB`);

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
    say(`Installed ${release.tag_name} to ${this.paths.llamaBinDir}`);
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
        replaceRunningFile(file, path.join(this.paths.llamaBinDir, path.basename(file))).catch(
          () => undefined,
        ),
      ),
    );
  }

  /**
   * Waits for the router, and **gives up the moment the child dies**.
   *
   * A llama-server that refuses its preset is gone in ~200 ms, and polling a port nothing will
   * ever answer on for the remaining 30 s does not make it come back — it just makes the user
   * watch a spinner for half a minute before being told what the process had already said. The
   * exit handler sets `#lastError` *before* it nulls `#process`, so a null `#process` here means
   * the reason is already known: report it rather than the timeout, which would blame the port.
   */
  private async waitForHealth(host: string, port: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    const url = `http://${host}:${port}/v1/models`;
    while (Date.now() < deadline) {
      if (await this.isServerHealthy(host, port, 750)) {
        return;
      }
      if (this.#process === null) {
        throw new Error(this.#lastError ?? 'llama-server exited before it became healthy');
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

/**
 * Copies a file into place **even when the running llama-server is using it**.
 *
 * You cannot overwrite a running executable on Linux: the kernel refuses with `ETXTBSY`
 * ("text file is busy"), and the same goes for a shared library a live process has mapped.
 * So updating llama.cpp while it was running failed *at the very last step* -- after a full
 * ten-minute build -- with a raw errno string. It had presumably always been broken, and it
 * was invisible: the old non-streaming route buffered the output and threw it away, and the
 * browser never showed the error.
 *
 * **Unlinking** a running binary is allowed, though: the process keeps its inode and carries
 * on happily with the old code until it is next restarted. So remove the directory entry
 * first and copy into the empty slot. That is also exactly the semantics we want -- the
 * running llama-server stays on the old build until the user restarts it, which they must do
 * anyway for a new binary to take effect.
 */
async function replaceRunningFile(source: string, destination: string): Promise<void> {
  await fs.rm(destination, {force: true});
  await fs.copyFile(source, destination);
}

function installInProgressError(): Error {
  const error = new Error('llama.cpp is already being installed. Watch the running install.');
  Object.assign(error, {code: NELLE_ERROR_CODES.runtimeInstallInProgress, retryable: false});
  return error;
}

/**
 * The four variables llama.cpp resolves its Hugging Face hub cache from, in the order
 * `common/hf-cache.cpp` reads them. `LLAMA_CACHE` wins outright and is used as the hub
 * root verbatim; the rest append their own suffix.
 */
const MODEL_CACHE_ENV_VARS = ['LLAMA_CACHE', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'HF_HOME'];

/**
 * Nelle keeps model weights **inside its data directory**, not in the user's global
 * `~/.cache/huggingface/hub`.
 *
 * The weights are the largest thing Nelle owns by two orders of magnitude, and they were
 * the last of its data living somewhere it did not control. Owning them means it can
 * account for the disk, and it means "what llama.cpp has cached" is "what Nelle
 * downloaded" -- which matters because the router advertises **every** cached GGUF as a
 * loadable model (`load_from_cache()`, and there is no flag to stop it), so a shared cache
 * hands it whatever any other tool ever pulled. It also isolates a throwaway
 * `NELLE_DATA_DIR`, which until now still reached into the developer's real weights: the
 * same class of surprise as an e2e run adopting a developer's llama-server.
 *
 * **An explicit choice wins.** A user who has set any of these -- to share a cache with
 * llama.cpp on the command line, or to put 50 GB on another disk -- has said what they
 * want, and `LLAMA_CACHE` outranks all of them, so setting it would silently overrule
 * them.
 */
export function modelCacheEnv(modelsDir: string): Record<string, string> {
  if (!ownsModelCache()) {
    return {};
  }
  return {LLAMA_CACHE: modelsDir};
}

/**
 * Whether the weights live in a directory Nelle owns.
 *
 * `false` when the user pointed llama.cpp at a cache of their own. Nelle will then neither
 * report on that directory's size nor delete anything from it: it may be shared with the
 * `hf` CLI, with a standalone llama.cpp, or with 50 GB of somebody else's models.
 */
export function ownsModelCache(): boolean {
  return !MODEL_CACHE_ENV_VARS.some(name => process.env[name]);
}
