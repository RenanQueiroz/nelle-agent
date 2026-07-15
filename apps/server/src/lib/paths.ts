import os from 'node:os';
import path from 'node:path';

export type AppPaths = {
  /**
   * The agent's working directory: the `cwd` host tools operate in, and the directory Pi loads
   * project context (`AGENTS.md`), skills and instructions from. Defaults to the user's home
   * directory -- Nelle is a general-purpose local agent, so it should reach `Downloads`,
   * `Documents` and the rest of the machine without ceremony -- and is overridable with
   * `NELLE_WORKSPACE_DIR`. Deliberately **not** the source tree: pointing the agent's cwd at the
   * repo made Pi's ancestor-walk load this repo's ~37k-token `AGENTS.md` into every prompt (a
   * one-line "hi" became a 36,010-token prompt). `os.homedir()` returns the correct location on
   * every OS (`%USERPROFILE%` on Windows).
   */
  workspaceDir: string;
  /**
   * Everything Nelle owns and generates: models, the llama.cpp build, Pi sessions, the settings
   * db, logs, uploads, attachments. Defaults to `~/.nelle` (hidden, the convention for app data --
   * cf. `~/.ollama`, `~/.cache/huggingface`), overridable with `NELLE_DATA_DIR`. It lives *outside*
   * the repo so a clone stays clean and a compiled binary does not write under its install dir.
   */
  dataDir: string;
  downloadsDir: string;
  /**
   * Where llama.cpp downloads model weights -- the single biggest thing Nelle owns, and
   * the last one that lived outside the data directory. It is a **Hugging Face hub cache**
   * (`models--org--repo/{blobs,snapshots,refs}`), handed to llama-server as `LLAMA_CACHE`.
   */
  modelsDir: string;
  attachmentsDir: string;
  uploadsDir: string;
  llamaDir: string;
  llamaBinDir: string;
  llamaSrcDir: string;
  llamaPresetPath: string;
  llamaPidPath: string;
  llamaLogPath: string;
  piDir: string;
  piSessionsDir: string;
  piAuthPath: string;
  piModelsPath: string;
  settingsDbPath: string;
  statePath: string;
};

export function createAppPaths(): AppPaths {
  const dataDir = path.resolve(process.env.NELLE_DATA_DIR ?? path.join(os.homedir(), '.nelle'));
  const workspaceDir = path.resolve(process.env.NELLE_WORKSPACE_DIR ?? os.homedir());
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    workspaceDir,
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
