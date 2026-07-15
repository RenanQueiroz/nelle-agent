import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';

/** An `AppPaths` rooted at [dataDir]. Nothing is created; the repositories do that. */
export function tempPaths(dataDir: string): AppPaths {
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');
  return {
    workspaceDir: dataDir,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    modelsDir: path.join(dataDir, 'models'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    uploadsDir: path.join(dataDir, 'uploads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
  };
}

/** `tempPaths` rooted at a fresh temp directory. */
export async function createTempPaths(): Promise<AppPaths> {
  return tempPaths(await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-')));
}
