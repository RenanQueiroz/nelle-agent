/**
 * The llama-server child: starting it, stopping it, and knowing whether it is alive.
 *
 * This is the only thing in Nelle that owns an OS process. It carries the three fields that go
 * with one -- the `Bun.Subprocess`, the pid it manages, and the in-flight start -- plus the pid
 * file that lets a restarted nelle-server *adopt* the llama-server it left behind (which is why
 * the child is spawned detached, and why it is not an orphan when it outlives us).
 *
 * **`#lastError` is not here.** `getStatus()` is the manager's hub -- it reads across the install
 * *and* the process -- and the last error is what it reports, so both stay with it and this class
 * reaches them through `host`. It cannot simply throw the child's death upwards instead: the exit
 * is asynchronous and nobody is awaiting it, so there is nobody to throw *at*. It writes the
 * reason through, and reads it back in `waitForHealth`, which is the one place that needs to know
 * why the process it is waiting for is already gone.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import type {AppPaths} from '../lib/paths';
import type {RuntimeLimits} from '../contracts/settings.ts';
import type {RuntimeStatus} from '../lib/types';
import type {AppStore} from '../models/store';
import {runCommand} from '../lib/process';
import type {RuntimeLogTail} from '../contracts/runtime.ts';
import {modelCacheEnv} from './weights.ts';
import {writePreset} from './preset.ts';

/** What the process needs from `LlamaCppManager`, which owns `getStatus()`, `#lastError`, and the install. */
export type LlamaProcessHost = {
  status(): Promise<RuntimeStatus>;
  /** Where llama-server lives. The install cluster's answer; the process only launches it. */
  binaryPath(): Promise<string | null>;
  lastError(): string | null;
  reportError(message: string | null): void;
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

export class LlamaProcess {
  #process: Bun.Subprocess | null = null;
  #managedPid: number | null = null;
  #startPromise: Promise<RuntimeStatus> | null = null;

  constructor(
    private readonly paths: AppPaths,
    private readonly store: AppStore,
    private readonly limits: () => RuntimeLimits,
    private readonly host: LlamaProcessHost,
  ) {}

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
    this.host.reportError(null);
    if (await this.getManagedPid()) {
      return this.host.status();
    }

    const binaryPath = await this.host.binaryPath();
    if (!binaryPath || !fsSync.existsSync(binaryPath)) {
      throw new Error(
        'llama-server is not installed. Install or configure LLAMA_SERVER_PATH first.',
      );
    }

    const state = await this.store.getState();
    if (await this.isServerHealthy(state.runtime.host, state.runtime.port, 500)) {
      this.host.reportError(
        'llama-server is already reachable on the configured port; Nelle did not start another process.',
      );
      return this.host.status();
    }

    await writePreset(this.paths, this.store);
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
    const limits = this.limits();
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
      this.host.reportError(error instanceof Error ? error.message : String(error));
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
      this.host.reportError(exitCode === 0 ? null : await this.describeExit(exitCode));
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
    return this.host.status();
  }

  async stop(): Promise<RuntimeStatus> {
    const pid = await this.getManagedPid();
    if (!pid) {
      this.#process = null;
      this.#managedPid = null;
      await this.clearPidFile();
      return this.host.status();
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
    return this.host.status();
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

  async getManagedPid(): Promise<number | null> {
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
      return (await Bun.file(this.paths.llamaPidPath).json()) as ManagedProcessRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await this.clearPidFile();
      }
      return null;
    }
  }

  private async writePidFile(record: ManagedProcessRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.paths.llamaPidPath), {recursive: true});
    await Bun.write(this.paths.llamaPidPath, `${JSON.stringify(record, null, 2)}\n`);
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
    const binaryPath = (await this.host.binaryPath()) ?? 'llama-server';
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

  async isServerHealthy(host: string, port: number, timeoutMs: number): Promise<boolean> {
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
        throw new Error(this.host.lastError() ?? 'llama-server exited before it became healthy');
      }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    throw new Error(`llama-server did not become healthy at ${url}`);
  }
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
      // procfs, where `stat` reports a size of 0 — `Bun.file()` sizes its read from that and
      // comes back empty. `fs.readFile` reads until EOF instead, which is the whole point here.
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
