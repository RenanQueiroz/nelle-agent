import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, type ChildProcess} from 'node:child_process';

import type {AppPaths} from './paths';
import type {ConfiguredModel, RuntimeStatus} from './types';
import {AppStore} from './store';
import {commandExists, runCommand} from './process';

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
  #process: ChildProcess | null = null;
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

    return {
      platform: process.platform,
      arch: process.arch,
      dataDir: this.paths.dataDir,
      binaryPath,
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
      running: this.isRunning(),
      pid: this.#process?.pid ?? null,
      host: state.runtime.host,
      port: state.runtime.port,
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

  async start(): Promise<RuntimeStatus> {
    this.#lastError = null;
    if (this.isRunning()) {
      return this.getStatus();
    }

    const binaryPath = await this.getBinaryPath();
    if (!binaryPath || !fsSync.existsSync(binaryPath)) {
      throw new Error(
        'llama-server is not installed. Install or configure LLAMA_SERVER_PATH first.',
      );
    }

    const activeModel = await this.store.getActiveModel();
    if (!activeModel) {
      throw new Error('Select or download a model before starting llama.cpp.');
    }

    await this.writePreset(activeModel);
    await fs.mkdir(path.dirname(this.paths.llamaLogPath), {recursive: true});
    const log = fsSync.openSync(this.paths.llamaLogPath, 'a');
    const state = await this.store.getState();
    const args = [
      '--host',
      state.runtime.host,
      '--port',
      String(state.runtime.port),
      '--models-preset',
      this.paths.llamaPresetPath,
      '--models-max',
      '1',
    ];

    const child = spawn(binaryPath, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', log, log],
    });

    this.#process = child;
    child.once('exit', code => {
      this.#lastError = code === 0 ? null : `llama-server exited with code ${code}`;
      this.#process = null;
      fsSync.closeSync(log);
    });
    child.once('error', error => {
      this.#lastError = error.message;
      this.#process = null;
      fsSync.closeSync(log);
    });

    await this.waitForHealth(state.runtime.host, state.runtime.port);
    return this.getStatus();
  }

  async stop(): Promise<RuntimeStatus> {
    const child = this.#process;
    if (!child?.pid) {
      this.#process = null;
      return this.getStatus();
    }

    if (process.platform === 'win32') {
      await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f']).catch(() => undefined);
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    this.#process = null;
    return this.getStatus();
  }

  async writePreset(activeModel: ConfiguredModel): Promise<void> {
    await fs.mkdir(path.dirname(this.paths.llamaPresetPath), {recursive: true});
    const params = activeModel.params;
    const lines = [
      'version = 1',
      '',
      '[*]',
      `c = ${params.contextSize}`,
      `n-gpu-layers = ${params.gpuLayers}`,
      ...(params.threads ? [`threads = ${params.threads}`] : []),
      ...(params.batchSize ? [`b = ${params.batchSize}`] : []),
      '',
      `[${activeModel.presetName}]`,
      ...modelSourceLines(activeModel),
      'load-on-startup = true',
      'stop-timeout = 10',
      '',
    ];
    await fs.writeFile(this.paths.llamaPresetPath, lines.join('\n'));
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

  private async getBinaryPath(): Promise<string | null> {
    const external = process.env.LLAMA_SERVER_PATH;
    if (external) {
      return path.resolve(external);
    }
    return path.join(this.paths.llamaBinDir, binaryName('llama-server'));
  }

  private isRunning(): boolean {
    return this.#process != null && !this.#process.killed;
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
      headers: {'user-agent': 'nelle-server-poc'},
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
      try {
        const response = await fetch(url);
        if (response.ok) {
          return;
        }
      } catch {
        // Keep waiting while the server boots.
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`llama-server did not become healthy at ${url}`);
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

function modelSourceLines(model: ConfiguredModel): string[] {
  if (model.hfRef) {
    return [`hf-repo = ${model.hfRef}`, `alias = ${model.hfRef}`];
  }
  if (model.path) {
    return [`model = ${model.path}`];
  }
  throw new Error(`Model ${model.name} has no local path or Hugging Face reference.`);
}
