/**
 * What a running download will total, learned by watching it — never by prediction.
 *
 * Which files a load downloads is llama.cpp's decision (the quant, its shards, an
 * auto-discovered mmproj or MTP head via `find_best_*`), and re-implementing those rules is the
 * drift that produced the MTP quant-picker bug. So this module never guesses: llama.cpp names
 * each blob after the file's content id — an LFS file's sha256, a small file's git oid — and the
 * repo tree (fetched at the very commit `refs/main` says the download resolved) maps those ids to
 * full sizes. The observed blobs *are* the choices; the tree prices them.
 *
 * The honesty rules live here too. A blob the tree cannot name, or a matched file with no known
 * size, forfeits the total — an understated total shows 100% and keeps downloading, which is the
 * exact lie the download label exists to kill. Bytes-only is the honest fallback, never a number
 * the evidence does not support.
 */

import type {RepoTreeFile} from '../models/huggingface.ts';
import {extractGgufQuants, isModelGguf} from '../models/huggingface.ts';

/**
 * Names a partially-written blob might carry while the downloader works on it. Stripped before
 * matching so an in-flight file attributes the same as a finished one.
 */
const PARTIAL_BLOB_SUFFIXES = ['.downloadInProgress', '.incomplete', '.part', '.tmp'];

export type BlobAttribution = {
  /** Present only when every observed blob is attributed and every matched file has a size. */
  totalBytes?: number;
  /** Blobs the tree could not name. Any entry here forfeits `totalBytes`. */
  unattributed: string[];
};

/**
 * Prices the observed blobs against the repo tree.
 *
 * `seedPaths` are files counted toward the total before their blobs appear — the quant's own
 * file(s), which are the one part of the download Nelle can name up front (same tag rule as
 * llama.cpp's `find_best_model`, see {@link seedPathsForQuant}). Accessories join by
 * observation as their blobs land, which reads as a single honest upward re-estimate of the
 * total, never as a finished download that keeps downloading.
 */
export function attributeBlobs(
  blobNames: string[],
  tree: RepoTreeFile[],
  seedPaths: string[] = [],
): BlobAttribution {
  const byLfsOid = new Map<string, RepoTreeFile>();
  const byOid = new Map<string, RepoTreeFile>();
  const byPath = new Map<string, RepoTreeFile>();
  for (const file of tree) {
    if (file.lfsOid) {
      byLfsOid.set(file.lfsOid, file);
    }
    if (file.oid) {
      byOid.set(file.oid, file);
    }
    byPath.set(file.path, file);
  }

  const matched = new Map<string, number | null>();
  for (const seed of seedPaths) {
    const file = byPath.get(seed);
    if (file) {
      matched.set(file.path, file.sizeBytes);
    }
  }

  const unattributed: string[] = [];
  for (const name of blobNames) {
    const key = stripPartialSuffix(name);
    const file = byLfsOid.get(key) ?? byOid.get(key);
    if (!file) {
      unattributed.push(name);
      continue;
    }
    matched.set(file.path, file.sizeBytes);
  }
  if (unattributed.length > 0) {
    return {unattributed};
  }

  let totalBytes = 0;
  for (const sizeBytes of matched.values()) {
    if (sizeBytes == null) {
      // A file Hugging Face did not size: the sum would be a lie, so there is none.
      return {unattributed: []};
    }
    totalBytes += sizeBytes;
  }
  return matched.size > 0 ? {totalBytes, unattributed: []} : {unattributed: []};
}

/**
 * The quant's own files, named from the tree the way llama.cpp names them.
 *
 * This is the *seed* — an accelerator so the total exists from the first tick, not a source of
 * truth. It applies `isModelGguf` first because `find_best_model` does (accessories can never be
 * reached by a quant tag), then matches the tag through the same grouping the import's quant
 * picker uses, shards included. A tag the tree cannot name seeds nothing, and attribution by
 * observation still carries the feature.
 */
export function seedPathsForQuant(tree: RepoTreeFile[], quant: string | null): string[] {
  if (!quant) {
    return [];
  }
  const candidates = tree
    .filter(file => file.path.endsWith('.gguf') && isModelGguf(file.path))
    .map(file => ({filename: file.path, size: file.sizeBytes}));
  const group = extractGgufQuants(candidates).find(entry => entry.quant === quant);
  return group?.files.map(file => file.filename) ?? [];
}

function stripPartialSuffix(name: string): string {
  for (const suffix of PARTIAL_BLOB_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}
