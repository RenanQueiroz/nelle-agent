import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The weights on disk: what a model costs, and reclaiming it.
 *
 * This is only possible, and only *safe*, because Nelle owns the cache. When the weights lived
 * in the user's global `~/.cache/huggingface/hub` they were shared with every other Hugging
 * Face tool, so deleting a model's blobs could have pulled the rug from under something else.
 * In `.nelle/models/` they are ours.
 */

/**
 * Hugging Face's own folder name for a repo: `models--org--repo`. `hf-cache.cpp`'s
 * `repo_to_folder_name` builds the same string, and the layout underneath is HF's
 * (`blobs/`, `snapshots/`, `refs/`).
 */
export function repoFolderName(repoId: string): string {
  return `models--${repoId.replaceAll('/', '--')}`;
}

/**
 * What this repo occupies, or `null` when nothing has been downloaded yet.
 *
 * Only regular files are counted -- the `snapshots/` entries are *symlinks* into `blobs/`, so
 * following them would count every byte twice.
 */
export async function repoDiskBytes(modelsDir: string, repoId: string): Promise<number | null> {
  const directory = path.join(modelsDir, repoFolderName(repoId));
  try {
    return await directoryBytes(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, {withFileTypes: true});
  let total = 0;
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(full);
    } else if (entry.isFile()) {
      // `isFile()` is false for a symlink, which is exactly what we want: the snapshot tree is
      // symlinks into `blobs/`, and following them would double-count the whole repo.
      total += (await fs.stat(full)).size;
    }
  }
  return total;
}

/** Deletes a repo's weights. Returns the bytes reclaimed. */
export async function removeRepoWeights(modelsDir: string, repoId: string): Promise<number> {
  const directory = path.join(modelsDir, repoFolderName(repoId));
  const bytes = (await repoDiskBytes(modelsDir, repoId)) ?? 0;
  await fs.rm(directory, {recursive: true, force: true});
  return bytes;
}

/**
 * The four variables llama.cpp resolves its Hugging Face hub cache from, in the order
 * `common/hf-cache.cpp` reads them. `LLAMA_CACHE` wins outright and is used as the hub
 * root verbatim; the rest append their own suffix.
 */
const MODEL_CACHE_ENV_VARS = ['LLAMA_CACHE', 'HF_HUB_CACHE', 'HUGGINGFACE_HUB_CACHE', 'HF_HOME'];

/**
 * Nelle keeps model weights **inside its data directory**, not in the user's global
 * `~/.cache/huggingface/hub`.
 *
 * The weights are the largest thing Nelle owns by two orders of magnitude, and they were
 * the last of its data living somewhere it did not control. Owning them means it can
 * account for the disk, and it means "what llama.cpp has cached" is "what Nelle
 * downloaded" -- which matters because the router advertises **every** cached GGUF as a
 * loadable model (`load_from_cache()`, and there is no flag to stop it), so a shared cache
 * hands it whatever any other tool ever pulled. It also isolates a throwaway
 * `NELLE_DATA_DIR`, which until now still reached into the developer's real weights: the
 * same class of surprise as an e2e run adopting a developer's llama-server.
 *
 * **An explicit choice wins.** A user who has set any of these -- to share a cache with
 * llama.cpp on the command line, or to put 50 GB on another disk -- has said what they
 * want, and `LLAMA_CACHE` outranks all of them, so setting it would silently overrule
 * them.
 */
export function modelCacheEnv(modelsDir: string): Record<string, string> {
  if (!ownsModelCache()) {
    return {};
  }
  return {LLAMA_CACHE: modelsDir};
}

/**
 * Whether the weights live in a directory Nelle owns.
 *
 * `false` when the user pointed llama.cpp at a cache of their own. Nelle will then neither
 * report on that directory's size nor delete anything from it: it may be shared with the
 * `hf` CLI, with a standalone llama.cpp, or with 50 GB of somebody else's models.
 */
export function ownsModelCache(): boolean {
  return !MODEL_CACHE_ENV_VARS.some(name => process.env[name]);
}
