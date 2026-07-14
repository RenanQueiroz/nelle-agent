import path from 'node:path';
import fs from 'node:fs/promises';

import type {ConversationDeleteResources} from '../conversations/repository';
import type {AppPaths} from './paths';

/**
 * Deleting and sweeping the files Nelle owns, and the guard that keeps every one of those
 * unlinks inside the data directory.
 *
 * `isPathWithin` is the load-bearing line. A storage path comes out of the database, and a
 * row is not a capability to unlink -- or to read -- any file on the machine: it is resolved
 * against the data directory and refused if it escapes. The same guard is what
 * `GET /api/attachments/:id/content` serves bytes behind.
 */

export type FileCleanupResult = {
  deleted: number;
  skipped: number;
  failed: Array<{path: string; message: string}>;
};

export async function deleteConversationResources(
  paths: AppPaths,
  resources: ConversationDeleteResources,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {deleted: 0, skipped: 0, failed: []};
  for (const sessionPath of resources.piSessionPaths) {
    await unlinkOwnedPath(paths.piSessionsDir, sessionPath, result);
  }
  for (const storagePath of resources.attachmentStoragePaths) {
    const attachmentPath = resolveRelativeDataPath(paths.dataDir, storagePath);
    if (!attachmentPath) {
      result.skipped += 1;
      continue;
    }
    await unlinkOwnedPath(paths.dataDir, attachmentPath, result, paths.attachmentsDir);
  }
  return result;
}

export async function sweepOrphanAttachmentFiles(
  paths: AppPaths,
  referencedStoragePaths: Set<string>,
): Promise<FileCleanupResult> {
  const result: FileCleanupResult = {deleted: 0, skipped: 0, failed: []};
  const attachmentsRoot = path.resolve(paths.attachmentsDir);
  const dataRoot = path.resolve(paths.dataDir);

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      result.failed.push({
        path: path.resolve(directory),
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        result.skipped += 1;
        continue;
      }

      const storagePath = path
        .relative(dataRoot, path.resolve(absolutePath))
        .split(path.sep)
        .join('/');
      if (referencedStoragePaths.has(storagePath)) {
        continue;
      }
      await unlinkOwnedPath(attachmentsRoot, absolutePath, result, attachmentsRoot);
    }
  }

  await visit(attachmentsRoot);
  return result;
}

async function unlinkOwnedPath(
  root: string,
  candidatePath: string,
  result: FileCleanupResult,
  pruneRoot = root,
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(candidatePath);
  if (!isPathWithin(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    result.skipped += 1;
    return;
  }
  try {
    await fs.unlink(resolvedPath);
    result.deleted += 1;
    await pruneEmptyParents(path.dirname(resolvedPath), pruneRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.skipped += 1;
      return;
    }
    result.failed.push({
      path: resolvedPath,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveRelativeDataPath(dataDir: string, relativePath: string): string | null {
  const resolved = path.resolve(dataDir, ...relativePath.split('/'));
  return isPathWithin(resolved, path.resolve(dataDir)) ? resolved : null;
}

async function pruneEmptyParents(start: string, root: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  let current = path.resolve(start);
  while (isPathWithin(current, resolvedRoot) && current !== resolvedRoot) {
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export function isPathWithin(candidatePath: string, root: string): boolean {
  return candidatePath === root || candidatePath.startsWith(`${root}${path.sep}`);
}
