import open from 'open';

import {createAppPaths} from './paths';
import {createServer} from './server';

const paths = createAppPaths();
const port = Number(process.env.NELLE_PORT ?? 8787);
const hostname = process.env.NELLE_HOST ?? '127.0.0.1';
const shouldOpen = process.argv.includes('--open');

const app = await createServer(paths);
const server = Bun.serve({
  port,
  hostname,
  // SSE runs (chat, regenerate, compact, the llama.cpp proxy) can go quiet while
  // a model loads; 255s is Bun's max idle window, and load progress keeps it warm.
  idleTimeout: 255,
  fetch: app.fetch,
});

const url = `http://${server.hostname}:${server.port}`;
console.log(`Nelle Agent listening on ${url}`);
console.log(`App data directory: ${paths.dataDir}`);

if (shouldOpen) {
  await open(url);
}

const shutdown = async (): Promise<void> => {
  console.log('Shutting down Nelle Agent');
  await server.stop();
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
