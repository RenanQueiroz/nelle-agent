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
 * `R` restart). That would silently cost you the live-reloading this command exists to give. So the
 * client is handed the **real terminal** (stdio inherited, hot reload fully live), and only the
 * server's output is piped and prefixed `[server]` into the same terminal. The server runs under
 * `bun --watch`, which restarts it on save; the client hot-reloads on `r`. One terminal, both live.
 *
 * **Auto hot reload on save.** The client is *also* hot-reloaded automatically when you save a
 * `.dart` file under `apps/client/lib`. Flutter has no watch-and-reload flag, and we cannot type `r`
 * for you — `flutter run` only reads the reload keys when its stdin is a real terminal, so feeding it
 * a pipe would take the manual `r`/`R`/`q` away from you too. Instead we use Flutter's own
 * out-of-band trigger: `--pid-file` writes the tool's PID, and **`SIGUSR1` to it is a hot reload**
 * (`SIGUSR2` a hot restart) — exactly what `r` does, so the interactive terminal is untouched and
 * both paths coexist. A debounced watcher signals it on save. POSIX-only (SIGUSR1 has no Windows
 * equivalent); on Windows, or with `NELLE_DEV_NO_RELOAD=1`, you fall back to pressing `r`. A change
 * to `pubspec.yaml` or native/platform config still needs a manual `R` (or a restart) — hot reload
 * only carries Dart edits.
 *
 * **The client target follows the host OS** — macOS → `macos`, Windows → `windows`, otherwise
 * `linux` — through the same `hostCapabilities()` the build command uses. There is nothing to
 * choose: you run the desktop app of the machine you are on, and Flutter cannot cross-compile a
 * desktop target anyway.
 *
 * **Quitting.** `q` in the client, or Ctrl-C, tears both down. As with `bun run dev:server`, a
 * managed llama-server is left running on purpose — it is detached for pid-file adoption, so the
 * next start adopts it rather than orphaning it.
 */

import {type Dirent, type FSWatcher, readdirSync, readFileSync, rmSync, watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {hostCapabilities} from './lib/hostCapabilities.ts';

const clientOnly = process.argv[2] === 'client';
const host = hostCapabilities();

if (!Bun.which('flutter')) {
  console.error(
    'flutter is not on PATH — cannot launch the client.\n' +
      'Run `bun run doctor` for the exact command to fix this on this machine.',
  );
  process.exit(1);
}

const useColor = process.stdout.isTTY;
const label = useColor ? '\x1b[36m[server]\x1b[0m ' : '[server] ';
const dim = (text: string): string => (useColor ? `\x1b[2m${text}\x1b[0m` : text);

/** Read a piped child stream and reprint it line by line under the `[server]` label. */
async function forward(stream: ReadableStream<Uint8Array>): Promise<void> {
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
      console.log(`${label}${line}`);
    }
  }
  if (buffer.length > 0) {
    console.log(`${label}${buffer}`);
  }
}

/**
 * Watch every `.dart` file under `apps/client/lib` and, on save, send `flutter run` a `SIGUSR1` (its
 * built-in hot-reload trigger) to the PID it wrote to `pidFile`. Returns a stop function.
 *
 * The PID is Flutter's, not ours: `client.pid` is the `flutter` wrapper, whose child is the tool that
 * actually hooks the signal, so we must signal the pid-file's PID, not the process we spawned. The
 * file appears once the app is up; before then a save simply no-ops (it is read fresh each time).
 */
function armHotReload(pidFile: string): () => void {
  const libDir = join(import.meta.dir, '..', 'apps', 'client', 'lib');
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = (): void => {
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

  const onDartChange = (_event: unknown, file: string | Buffer | null): void => {
    if (typeof file !== 'string' || !file.endsWith('.dart')) {
      return;
    }
    // Editors write a file several times per save (temp + rename); coalesce into one reload.
    clearTimeout(timer);
    timer = setTimeout(reload, 150);
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

// In the combined case the server comes up first, piped and prefixed; client-only skips it.
const server = clientOnly
  ? null
  : Bun.spawn(['bun', '--watch', 'apps/server/src/index.ts'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
if (server) {
  void forward(server.stdout);
  void forward(server.stderr);
}

console.log(
  dim(
    clientOnly
      ? `Starting the ${host.os} client (hot reload)…`
      : `Starting Nelle — server (watch) + ${host.os} client (hot reload)…`,
  ),
);

// Flutter's PID lands here so the watcher can signal it; per-dev-process so two sessions never clash.
const pidFile = join(tmpdir(), `nelle-dev-flutter-${process.pid}.pid`);

// The client gets the real terminal, so its interactive hot-reload keys keep working.
const client = Bun.spawn(['flutter', 'run', '-d', host.os, '--pid-file', pidFile], {
  cwd: 'apps/client',
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

// Auto hot reload on save (POSIX only — SIGUSR1 has no Windows equivalent), opt-out via env.
let stopReload = (): void => {};
if (host.os === 'windows') {
  console.log(dim('Auto hot reload on save is off on Windows — press r in the client to reload.'));
} else if (process.env.NELLE_DEV_NO_RELOAD) {
  console.log(
    dim('Auto hot reload on save is disabled (NELLE_DEV_NO_RELOAD) — press r to reload.'),
  );
} else {
  stopReload = armHotReload(pidFile);
  console.log(
    dim(
      'Auto hot reload on save is on (apps/client/lib/**.dart) — r reloads, R restarts manually.',
    ),
  );
}

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    stopReload();
    client.kill();
    // Flutter deletes the pid-file when its signal handlers unhook; clean it up if it crashed instead.
    rmSync(pidFile, {force: true});
    if (server) {
      server.kill();
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
