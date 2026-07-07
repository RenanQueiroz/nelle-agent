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

const app = await createServer(createAppPaths());
await app.listen({host: '127.0.0.1', port: 8799});

const shutdown = async () => {
  await app.close();
};

process.on('SIGINT', () => {
  void shutdown().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void shutdown().finally(() => process.exit(0));
});
