import {fileURLToPath} from 'node:url';
import path from 'node:path';

export type AppPaths = {
  repoRoot: string;
  dataDir: string;
  modelsDir: string;
  downloadsDir: string;
  llamaDir: string;
  llamaBinDir: string;
  llamaSrcDir: string;
  llamaPresetPath: string;
  llamaLogPath: string;
  piDir: string;
  piAuthPath: string;
  piModelsPath: string;
  statePath: string;
  webDistDir: string;
};

export function createAppPaths(): AppPaths {
  const repoRoot = path.resolve(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const dataDir = path.resolve(process.env.NELLE_DATA_DIR ?? path.join(repoRoot, '.nelle'));
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    modelsDir: path.join(dataDir, 'models'),
    downloadsDir: path.join(dataDir, 'downloads'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    statePath: path.join(dataDir, 'state.json'),
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}

