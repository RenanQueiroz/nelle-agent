import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {createAppPaths} from '../apps/server/src/paths';
import {createServer} from '../apps/server/src/server';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.join(repoRoot, '.nelle-e2e');

await fs.rm(dataDir, {recursive: true, force: true});

const build = spawnSync('npm', ['run', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

process.env.NELLE_DATA_DIR = dataDir;
process.env.NELLE_PORT = '8799';
process.env.NELLE_HOST = '127.0.0.1';
// The runtime status probe treats any healthy server on this port as "llama.cpp
// is already running". Keep e2e off 8080 so a developer's own llama-server does
// not make the suite think a runtime is installed and running.
process.env.NELLE_LLAMA_PORT = '18080';

const app = await createServer(createAppPaths());

// `createServer` returns a `fetch` handler, not a Fastify app: this still called
// `app.listen()`, which has not existed since the move to `Bun.serve`, so the whole
// Playwright suite failed to start its own server and never ran. Mirrors `index.ts`.
//
// The listener is **trusted**, like loopback in production: e2e drives the browser
// against a local server, and requiring a paired device token would test the harness
// rather than the app.
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 8799,
  // SSE runs can go quiet while a model loads; 255s is Bun's max idle window.
  idleTimeout: 255,
  fetch: req => app.handle(req, {trusted: true}),
});

const shutdown = async () => {
  // `stop()` is graceful and waits for in-flight requests -- and an SSE stream never
  // finishes, so a graceful stop hangs forever with a client connected. Playwright
  // would then never get its port back.
  await server.stop(true);
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
