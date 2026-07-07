import open from 'open';

import {createAppPaths} from './paths';
import {createServer} from './server';

const paths = createAppPaths();
const port = Number(process.env.NELLE_PORT ?? 8787);
const host = process.env.NELLE_HOST ?? '127.0.0.1';
const shouldOpen = process.argv.includes('--open');

const app = await createServer(paths);
await app.listen({host, port});

const url = `http://${host}:${port}`;
app.log.info(`Nelle Server listening on ${url}`);
app.log.info(`App data directory: ${paths.dataDir}`);

if (shouldOpen) {
  await open(url);
}

const shutdown = async () => {
  app.log.info('Shutting down Nelle Server');
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
