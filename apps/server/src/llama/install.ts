/**
 * Getting llama.cpp onto the machine: the Linux source build, the GitHub release for everyone
 * else, and knowing which version is on disk.
 *
 * **An install is a build, not a request.** On Linux it is a `git clone` plus a full cmake
 * compile -- measured at ~3 minutes with a warm ccache and CUDA, and much longer cold -- which is
 * why the output is streamed line by line rather than buffered and discarded, and why `#installing`
 * exists: the button shows nothing for minutes, so clicking it twice is the obvious thing to do,
 * and two builds would `rm -rf` each other's `build/`.
 *
 * `status` is injected because `installOrUpdate` answers with a `RuntimeStatus`, which is the
 * manager's to report -- it reads this cluster's binary path *and* the process's pid -- and it
 * must be read while the install lock is still held. `reportError` writes `#lastError`, which
 * stays with `getStatus` for the same reason.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import type {AppPaths} from '../lib/paths';
import type {RuntimeStatus} from '../lib/types';
import {
  commandExists,
  runCommand,
  runCommandStreaming,
  type CommandOutputLine,
} from '../lib/process';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';

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

/** What the install needs from `LlamaCppManager`, which owns `getStatus()` and `#lastError`. */
export type LlamaInstallHost = {
  status(checkLatest?: boolean): Promise<RuntimeStatus>;
  reportError(message: string | null): void;
};

export class LlamaInstall {
  /**
   * A source build takes minutes and the button shows nothing, so a second click is not an
   * exotic race -- it is the obvious thing to do. Two concurrent builds would fight over
   * the same `build/` directory, which `buildLinuxFromMaster` starts by `rm -rf`-ing.
   */
  #installing = false;

  constructor(
    private readonly paths: AppPaths,
    private readonly host: LlamaInstallHost,
  ) {}

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
    this.host.reportError(null);
    try {
      if (process.env.LLAMA_SERVER_PATH) {
        // `external`: the binary is the user's, so there is nothing to build.
        return await this.host.status(true);
      }
      if (process.platform === 'linux') {
        await this.buildLinuxFromMaster(options.onOutput);
      } else {
        await this.installFromGithubRelease(options.onOutput);
      }
      return await this.host.status(true);
    } catch (error) {
      this.host.reportError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      this.#installing = false;
    }
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

  async getBinaryPath(): Promise<string | null> {
    const external = process.env.LLAMA_SERVER_PATH;
    if (external) {
      return path.resolve(external);
    }
    return path.join(this.paths.llamaBinDir, binaryName('llama-server'));
  }

  async getInstalledVersion(): Promise<string | null> {
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

  async getLatestVersion(): Promise<string | null> {
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
