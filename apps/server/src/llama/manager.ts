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
import {LlamaProcess} from './process.ts';
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

export class LlamaCppManager {
  /**
   * Why llama-server is not running, when it should be. **The manager's, and it stays here**:
   * `getStatus()` is the hub that reports it, and every collaborator that can fail writes
   * through to it rather than keeping a second copy nobody would read.
   */
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

  /**
   * The llama-server child, its pid file, and the in-flight start. The only thing here that owns
   * an OS process -- and the only reason `#lastError` has a setter: the child's exit is
   * asynchronous, so its death cannot be thrown at anybody.
   */
  readonly #process: LlamaProcess;

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
    this.#process = new LlamaProcess(paths, store, () => this.#limits(), {
      status: () => this.getStatus(),
      binaryPath: () => this.getBinaryPath(),
      lastError: () => this.#lastError,
      reportError: message => {
        this.#lastError = message;
      },
    });
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
    const managedPid = await this.#process.getManagedPid();
    const serverAlreadyReachable =
      managedPid == null &&
      (await this.#process.isServerHealthy(state.runtime.host, state.runtime.port, 300));

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
}

function binaryName(base: string): string {
  return process.platform === 'win32' ? `${base}.exe` : base;
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
