import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {createAppPaths} from '../apps/server/src/lib/paths.ts';
import {createServer} from '../apps/server/src/server.ts';

// A throwaway data dir so generating the spec never touches real .nelle data.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-openapi-'));
process.env.NELLE_DATA_DIR = tmp;
// ...and a throwaway workspace, so it never falls back to the developer's home directory.
process.env.NELLE_WORKSPACE_DIR = path.join(tmp, 'workspace');

const app = await createServer(createAppPaths());
const response = await app.handle(new Request('http://localhost/api/openapi.json'), {
  trusted: true,
});
const document = `${JSON.stringify(await response.json(), null, 2)}\n`;
await Bun.write('openapi.json', document);
await app.close();
await fs.rm(tmp, {recursive: true, force: true});
console.log('wrote openapi.json');
