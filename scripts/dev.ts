/**
 * `bun run dev` — the server and the desktop client together, in one terminal, both live.
 * `bun run dev:client` — the same client on its own (this script with the `client` argument).
 *
 * (`bun run dev:server` is not this script: it is the raw `bun --watch apps/server/src/index.ts`,
 * so the server-only case stays a single supervised process with no wrapper in front of it.)
 *
 * **Why this is a script and not `concurrently`.** A prefixing multiplexer pipes each child's stdout
 * so it can prepend a label, and `flutter run` checks whether *its* stdout is a real terminal —
 * seeing a pipe, it drops into non-interactive mode and disables the hot-reload keys (`r` reload,
 * `R` restart). That would silently cost you the live-reloading this command exists to give. So on
 * POSIX the client is handed the **real terminal** (stdio inherited, hot reload fully live), and only
 * the server's output is piped and prefixed `[server]` into the same terminal. The server runs under
 * `bun --watch`, which restarts it on save; the client hot-reloads on `r`. One terminal, both live.
 *
 * **Auto hot reload on save — two mechanisms, one for each OS family.**
 * - **POSIX (macOS/Linux):** the native `flutter run` above, plus `--pid-file`. Flutter has no watch
 *   flag, and it reads its `r`/`R`/`q` keys only when its stdin is a real terminal — so feeding it a
 *   pipe to type `r` into would take the manual keys away from the human too. Instead we use Flutter's
 *   own out-of-band trigger: `--pid-file` writes the tool's PID, and **`SIGUSR1` to it is a hot
 *   reload** (`SIGUSR2` a hot restart) — byte-for-byte what `r` does, so the interactive terminal is
 *   untouched and both paths coexist. A debounced watcher signals it on save.
 * - **Windows:** SIGUSR1 does not exist there (neither Bun's `process.kill` nor Dart's signal
 *   handling has it), so the pid-file trick is a no-op. Instead we run `flutter run --machine` — the
 *   daemon/JSON-RPC protocol — and drive it ourselves: parse its event stream, print friendly status,
 *   and on save send `app.restart {fullRestart: false}`, which is a *correct* hot reload (it recompiles
 *   through Flutter's own `frontend_server`, unlike a raw VM-service `reloadSources`). `--machine` has
 *   no built-in interactive keys, so we forward `r`/`R`/`q` from our own stdin to daemon commands to
 *   keep parity. `NELLE_DEV_MACHINE=1` forces this daemon path on any OS (useful for trying it on
 *   POSIX, and how the Windows path is exercised on a Mac — the protocol is platform-independent).
 *
 * `NELLE_DEV_NO_RELOAD=1` disables auto reload entirely and keeps the plain native `flutter run`
 * (press `r` yourself). A `pubspec.yaml` or native/platform change still needs a manual `R`; hot
 * reload only carries Dart edits.
 *
 * **The client target follows the host OS** — macOS → `macos`, Windows → `windows`, otherwise
 * `linux` — through the same `hostCapabilities()` the build command uses. There is nothing to
 * choose: you run the desktop app of the machine you are on, and Flutter cannot cross-compile a
 * desktop target anyway.
 *
 * **Quitting.** `q` in the client, or Ctrl-C, tears both down — and the server takes its
 * llama-server with it, so nothing is left holding the port or the VRAM. (`NELLE_KEEP_LLAMA=1`
 * restores the old behaviour, where llama-server outlived the restart and the next start adopted
 * it through its pid file; worth it in a session where reloading weights costs more than the
 * stray process does.)
 */

import {type Dirent, type FSWatcher, readdirSync, readFileSync, rmSync, watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {hostCapabilities} from './lib/hostCapabilities.ts';

const clientOnly = process.argv[2] === 'client';
const host = hostCapabilities();
const autoReload = !process.env.NELLE_DEV_NO_RELOAD;
// The daemon (`--machine`) path is required on Windows (no SIGUSR1) and opt-in elsewhere.
const useMachine = host.os === 'windows' || process.env.NELLE_DEV_MACHINE === '1';

if (!Bun.which('flutter')) {
  console.error(
    'flutter is not on PATH — cannot launch the client.\n' +
      'Run `bun run doctor` for the exact command to fix this on this machine.',
  );
  process.exit(1);
}

const useColor = process.stdout.isTTY;
const serverLabel = useColor ? '\x1b[36m[server]\x1b[0m ' : '[server] ';
const clientLabel = useColor ? '\x1b[35m[client]\x1b[0m ' : '[client] ';
const dim = (text: string): string => (useColor ? `\x1b[2m${text}\x1b[0m` : text);

/** Read a piped child stream and reprint it line by line under `prefix`. */
async function forward(stream: ReadableStream<Uint8Array>, prefix: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {stream: true});
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      console.log(`${prefix}${line}`);
    }
  }
  if (buffer.length > 0) {
    console.log(`${prefix}${buffer}`);
  }
}

/**
 * Watch every `.dart` file under `apps/client/lib` and call `onSave` (debounced) when one changes.
 * The *how* of reloading is the caller's — a POSIX signal or a daemon command. Returns a stop
 * function.
 */
function watchDartSaves(onSave: () => void): () => void {
  const libDir = join(import.meta.dir, '..', 'apps', 'client', 'lib');
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onDartChange = (_event: unknown, file: string | Buffer | null): void => {
    if (typeof file !== 'string' || !file.endsWith('.dart')) {
      return;
    }
    // Editors write a file several times per save (temp + rename); coalesce into one reload.
    clearTimeout(timer);
    timer = setTimeout(onSave, 150);
  };

  // Prefer one recursive watch; fall back to a watch per directory where recursion is unsupported
  // (some Linux setups), walking the tree once. New directories mid-session are the rare exception.
  const watchers: FSWatcher[] = [];
  try {
    watchers.push(watch(libDir, {recursive: true}, onDartChange));
  } catch {
    for (const dir of walkDirs(libDir)) {
      watchers.push(watch(dir, onDartChange));
    }
  }

  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

/** Every directory at or under `root`, for the non-recursive watch fallback. */
function walkDirs(root: string): string[] {
  const dirs = [root];
  let entries: Dirent[];
  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch {
    return dirs;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(...walkDirs(join(root, entry.name)));
    }
  }
  return dirs;
}

/**
 * POSIX reload: send `flutter run`'s built-in `SIGUSR1` (hot reload) to the PID it wrote to
 * `pidFile`. The PID is Flutter's tool, not `client.pid`: the process we spawn is the `flutter`
 * wrapper, whose child hooks the signal, so signalling the wrapper would just kill it. The file
 * appears once the app is up; before then a save no-ops (it is read fresh each time).
 */
function makeSignalReloader(pidFile: string): () => void {
  return () => {
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    } catch {
      return; // The app is not up yet — nothing to signal.
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    // A stale PID (the app was restarted or quit) throws ESRCH; the next save re-reads the file.
    try {
      process.kill(pid, 'SIGUSR1');
    } catch {
      /* no live tool to reload */
    }
  };
}

/**
 * A minimal client for `flutter run --machine` (the daemon JSON-RPC protocol), used on Windows where
 * SIGUSR1 does not exist. It reads the newline-delimited `[{…}]` messages off the tool's stdout,
 * tracks the `appId`, and sends `app.restart` requests. `app.restart {fullRestart:false}` is a real
 * hot reload — the daemon recompiles through `frontend_server` — which a raw VM-service `reloadSources`
 * would not do.
 */
class FlutterDaemon {
  readonly #stdin: Bun.FileSink;
  readonly #stdout: ReadableStream<Uint8Array>;
  readonly #onStarted: () => void;
  #appId: string | null = null;
  #started = false;
  #nextId = 0;
  #buffer = '';
  readonly #pending = new Map<
    number,
    {resolve: (result: unknown) => void; reject: (error: Error) => void}
  >();

  constructor(
    stdout: ReadableStream<Uint8Array>,
    stdin: Bun.FileSink,
    options: {onStarted: () => void},
  ) {
    this.#stdout = stdout;
    this.#stdin = stdin;
    this.#onStarted = options.onStarted;
    void this.#readStdout();
  }

  /** Trigger a hot reload (or, with `fullRestart`, a hot restart). No-op until the app is up. */
  async restart(fullRestart: boolean): Promise<void> {
    if (this.#appId === null) {
      return;
    }
    try {
      const result = (await this.#send('app.restart', {
        appId: this.#appId,
        fullRestart,
        pause: false,
        reason: fullRestart ? 'manual' : 'save',
      })) as {code?: number; message?: string} | null;
      if (result?.code === 0) {
        console.log(clientLabel + (fullRestart ? 'hot restarted' : 'hot reloaded'));
      } else {
        console.log(clientLabel + `reload failed: ${result?.message ?? 'see errors above'}`);
      }
    } catch (error) {
      console.log(clientLabel + `reload error: ${(error as Error).message}`);
    }
  }

  /**
   * Ask the daemon to stop the app. This is required for a clean teardown: unlike native
   * `flutter run`, the `--machine` tool does **not** stop its app on SIGTERM, so simply killing the
   * process would orphan the running app. Resolves when the app has stopped (bounded by the caller).
   */
  async stop(): Promise<void> {
    if (this.#appId === null) {
      return;
    }
    try {
      await this.#send('app.stop', {appId: this.#appId});
    } catch {
      /* the tool is already gone */
    }
  }

  #send(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject});
      this.#stdin.write(`${JSON.stringify([{id, method, params}])}\n`);
      this.#stdin.flush();
    });
  }

  async #readStdout(): Promise<void> {
    const reader = this.#stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      this.#buffer += decoder.decode(value, {stream: true});
      let newline = this.#buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line) {
          this.#handleLine(line);
        }
        newline = this.#buffer.indexOf('\n');
      }
    }
  }

  #handleLine(line: string): void {
    // The daemon wraps every message as a one-element JSON array; anything else is stray output.
    if (!line.startsWith('[')) {
      console.log(clientLabel + line);
      return;
    }
    let messages: Array<Record<string, unknown>>;
    try {
      messages = JSON.parse(line) as Array<Record<string, unknown>>;
    } catch {
      console.log(clientLabel + line);
      return;
    }
    for (const message of messages) {
      this.#handleMessage(message);
    }
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.event === 'string') {
      this.#handleEvent(message.event, (message.params ?? {}) as Record<string, unknown>);
    }
  }

  #handleEvent(event: string, params: Record<string, unknown>): void {
    switch (event) {
      case 'app.start':
        if (typeof params.appId === 'string') {
          this.#appId = params.appId;
        }
        break;
      case 'app.debugPort':
        if (typeof params.wsUri === 'string') {
          console.log(clientLabel + `VM Service: ${params.wsUri}`);
        }
        break;
      case 'app.started':
        if (!this.#started) {
          this.#started = true;
          this.#onStarted();
        }
        break;
      case 'app.progress':
        if (typeof params.message === 'string' && params.finished !== true) {
          console.log(clientLabel + params.message);
        }
        break;
      case 'app.log':
        if (typeof params.log === 'string') {
          (params.error === true ? console.error : console.log)(clientLabel + params.log);
        }
        break;
      case 'daemon.logMessage':
        if (typeof params.message === 'string') {
          console.log(clientLabel + params.message);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * `--machine` has no interactive keys of its own, so forward the essential ones from our stdin to
 * daemon commands: `r` reload, `R` restart, `q`/Ctrl-C quit. In raw mode Ctrl-C arrives as a byte
 * (0x03) rather than a signal, so it is handled here. No-op when stdin is not a terminal (a
 * backgrounded run), where there are no keystrokes to read.
 */
function forwardKeystrokes(daemon: FlutterDaemon, onQuit: () => void): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return () => {};
  }
  stdin.setRawMode(true);
  stdin.resume();
  const restore = (): void => {
    if (stdin.isTTY) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* terminal already gone */
      }
    }
  };
  const onData = (data: Buffer): void => {
    for (const byte of data) {
      if (byte === 0x72) {
        void daemon.restart(false); // r
      } else if (byte === 0x52) {
        void daemon.restart(true); // R
      } else if (byte === 0x71 || byte === 0x03) {
        onQuit(); // q or Ctrl-C
      }
    }
  };
  stdin.on('data', onData);
  process.once('exit', restore);
  return () => {
    stdin.off('data', onData);
    restore();
    stdin.pause();
  };
}

// In the combined case the server comes up first, piped and prefixed; client-only skips it.
const server = clientOnly
  ? null
  : Bun.spawn(['bun', '--watch', 'apps/server/src/index.ts'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
if (server) {
  void forward(server.stdout, serverLabel);
  void forward(server.stderr, serverLabel);
}

console.log(
  dim(
    clientOnly
      ? `Starting the ${host.os} client (hot reload)…`
      : `Starting Nelle — server (watch) + ${host.os} client (hot reload)…`,
  ),
);

let client: Bun.Subprocess;
let pidFile: string | null = null;
let daemon: FlutterDaemon | null = null;
let stopReload = (): void => {};
let stopKeys = (): void => {};

if (useMachine && autoReload) {
  // Windows (or NELLE_DEV_MACHINE): drive the daemon ourselves. stdio is piped, not inherited.
  const machineClient = Bun.spawn(['flutter', 'run', '--machine', '-d', host.os], {
    cwd: 'apps/client',
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  daemon = new FlutterDaemon(machineClient.stdout, machineClient.stdin, {
    onStarted: () =>
      console.log(dim('Auto hot reload on save is on — r reloads · R restarts · q quits.')),
  });
  void forward(machineClient.stderr, clientLabel);
  stopReload = watchDartSaves(() => void daemon?.restart(false));
  stopKeys = forwardKeystrokes(daemon, () => void shutdown(0));
  client = machineClient;
} else {
  // Native `flutter run` with the real terminal, so its interactive keys keep working.
  const withPid = autoReload && host.os !== 'windows';
  pidFile = withPid ? join(tmpdir(), `nelle-dev-flutter-${process.pid}.pid`) : null;
  const args = ['flutter', 'run', '-d', host.os];
  if (pidFile) {
    args.push('--pid-file', pidFile);
  }
  client = Bun.spawn(args, {
    cwd: 'apps/client',
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (pidFile) {
    stopReload = watchDartSaves(makeSignalReloader(pidFile));
    console.log(
      dim('Auto hot reload on save is on (apps/client/lib/**.dart) — r reloads, R restarts.'),
    );
  } else if (host.os === 'windows') {
    console.log(dim('Auto hot reload on save is off (NELLE_DEV_NO_RELOAD) — press r to reload.'));
  } else {
    console.log(
      dim('Auto hot reload on save is disabled (NELLE_DEV_NO_RELOAD) — press r to reload.'),
    );
  }
}

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    stopKeys();
    stopReload();
    // The `--machine` tool does not stop its app on a kill, so ask it to first (bounded), or the
    // app is orphaned. Native `flutter run` needs none of this — killing it tears the app down.
    if (daemon) {
      await Promise.race([daemon.stop(), Bun.sleep(3000)]);
    }
    // **Signal both children before awaiting either.** The server is `bun --watch`, a supervisor
    // plus a child, and delaying its SIGTERM even a second lets the supervisor outlive the
    // shutdown: it reparents to init and the next `bun run dev` meets it again. (Measured: moving
    // `server.kill()` after a wait orphaned it on every run; here it never does.)
    client.kill();
    server?.kill();
    // **Only *then* clean up the pid file, and only if Flutter did not.** Flutter deletes the
    // file itself as its signal handlers unhook, and a Ctrl-C signals the whole foreground
    // process group — so the tool is tearing down at the same instant we are. Removing it here
    // immediately won that race on essentially every Ctrl-C, after which Flutter warned "Failed
    // to delete pid file (...): Cannot delete file" about a file that was no longer its problem.
    // Bounded: if the tool crashed instead of exiting, the file is ours to remove.
    if (pidFile) {
      await Promise.race([client.exited, Bun.sleep(3000)]);
      rmSync(pidFile, {force: true});
    }
    if (server) {
      // Let the server print its "Shutting down" line before we go; it is bounded anyway.
      await Promise.race([server.exited, Bun.sleep(3000)]);
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

// When the client exits on its own (the user pressed `q`), take the server down with it.
await shutdown(await client.exited);
