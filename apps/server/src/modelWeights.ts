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
