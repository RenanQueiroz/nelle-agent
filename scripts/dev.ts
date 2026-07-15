/**
 * `bun run dev:all` — the server and the desktop client together, in one terminal, both live.
 *
 * **Why this is a script and not `concurrently`.** A prefixing multiplexer pipes each child's stdout
 * so it can prepend a label, and `flutter run` checks whether *its* stdout is a real terminal —
 * seeing a pipe, it drops into non-interactive mode and disables the hot-reload keys (`r` reload,
 * `R` restart). That would silently cost you the live-reloading this command exists to give. So the
 * client is handed the **real terminal** (stdio inherited, hot reload fully live), and only the
 * server's output is piped and prefixed `[server]` into the same terminal. The server runs under
 * `bun --watch`, which restarts it on save; the client hot-reloads on `r`. One terminal, both live.
 *
 * **The client target follows the host OS** — macOS → `macos`, Windows → `windows`, otherwise
 * `linux` — through the same `hostCapabilities()` the build command uses. There is nothing to
 * choose: you run the desktop app of the machine you are on, and Flutter cannot cross-compile a
 * desktop target anyway.
 *
 * **Quitting.** `q` in the client, or Ctrl-C, tears both down. As with `bun run dev`, a managed
 * llama-server is left running on purpose — it is detached for pid-file adoption, so the next start
 * adopts it rather than orphaning it.
 */

import {hostCapabilities} from './lib/hostCapabilities.ts';

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

console.log(dim(`Starting Nelle — server (watch) + ${host.os} client (hot reload)…`));

const server = Bun.spawn(['bun', '--watch', 'apps/server/src/index.ts'], {
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
});
void forward(server.stdout);
void forward(server.stderr);

// The client gets the real terminal, so its interactive hot-reload keys keep working.
const client = Bun.spawn(['flutter', 'run', '-d', host.os], {
  cwd: 'apps/client',
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    client.kill();
    server.kill();
    // Let the server print its "Shutting down" line before we go; it is bounded anyway.
    await Promise.race([server.exited, Bun.sleep(3000)]);
  }
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(130));
process.on('SIGTERM', () => void shutdown(143));

// When the client exits on its own (the user pressed `q`), take the server down with it.
await shutdown(await client.exited);
