import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'bun:test';

import {AppDatabase} from '../../apps/server/src/database.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {UPLOAD_TTL_MS, UploadRepository} from '../../apps/server/src/uploads.ts';

const HOUR_MS = 60 * 60 * 1000;

test('an upload writes its bytes under the uploads tree and reads them back', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const upload = await uploads.create({
      kind: 'text',
      name: 'notes.md',
      mimeType: 'text/markdown',
      bytes: Buffer.from('hello'),
      textContent: 'hello',
    });

    assert.equal(upload.sizeBytes, 5);
    // Storage paths are relative to the data dir, POSIX-style, like attachments.
    assert.equal(upload.storagePath, `uploads/${upload.id}/content`);
    assert.equal(upload.boundAt, undefined);
    assert.equal((await uploads.readBytes(upload)).toString(), 'hello');

    const reloaded = uploads.get(upload.id);
    assert.equal(reloaded?.name, 'notes.md');
    assert.equal(reloaded?.textContent, 'hello');
    assert.equal(reloaded?.kind, 'text');
  } finally {
    database.close();
  }
});

test('an unbound upload past the TTL is swept; a fresh one is not', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const stale = await uploads.create({kind: 'text', name: 'old.txt', bytes: Buffer.from('a')});
    const fresh = await uploads.create({kind: 'text', name: 'new.txt', bytes: Buffer.from('b')});
    backdate(database, stale.id, Date.now() - UPLOAD_TTL_MS - HOUR_MS);

    assert.deepEqual(await uploads.sweepExpired(), {deleted: 1});
    assert.equal(uploads.get(stale.id), null);
    assert.equal(await exists(paths, stale), false, 'the bytes go with the row');
    assert.notEqual(uploads.get(fresh.id), null);
    assert.equal(await exists(paths, fresh), true);
  } finally {
    database.close();
  }
});

test('a bound upload is never swept, however old it is', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const sent = await uploads.create({kind: 'image', name: 'a.png', bytes: Buffer.from('x')});
    uploads.markBound(sent.id);
    backdate(database, sent.id, Date.now() - UPLOAD_TTL_MS * 30);

    // It belongs to a message now. It is swept with its conversation, not on a timer.
    assert.deepEqual(await uploads.sweepExpired(), {deleted: 0});
    assert.notEqual(uploads.get(sent.id), null);
    assert.equal(await exists(paths, sent), true);
  } finally {
    database.close();
  }
});

test('the TTL boundary is exclusive: exactly at the cutoff survives', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const upload = await uploads.create({kind: 'text', name: 'a.txt', bytes: Buffer.from('a')});
    const now = Date.now();
    backdate(database, upload.id, now - UPLOAD_TTL_MS);

    assert.deepEqual(await uploads.sweepExpired(now), {deleted: 0});
    assert.deepEqual(await uploads.sweepExpired(now + 1), {deleted: 1});
  } finally {
    database.close();
  }
});

test('deleting an unsent draft removes its bytes; deleting a sent one is refused', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const draft = await uploads.create({kind: 'text', name: 'a.txt', bytes: Buffer.from('a')});
    assert.equal(await uploads.deleteUnbound(draft.id), true);
    assert.equal(uploads.get(draft.id), null);
    assert.equal(await exists(paths, draft), false);

    const sent = await uploads.create({kind: 'text', name: 'b.txt', bytes: Buffer.from('b')});
    uploads.markBound(sent.id);
    assert.equal(await uploads.deleteUnbound(sent.id), false, 'a sent attachment is not a draft');
    assert.notEqual(uploads.get(sent.id), null);
    assert.equal(await exists(paths, sent), true);

    assert.equal(await uploads.deleteUnbound('does-not-exist'), false);
  } finally {
    database.close();
  }
});

test('binding is idempotent, so a retried send does not move the timestamp', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const upload = await uploads.create({kind: 'text', name: 'a.txt', bytes: Buffer.from('a')});
    uploads.markBound(upload.id);
    const first = uploads.get(upload.id)?.boundAt;
    uploads.markBound(upload.id);
    assert.equal(uploads.get(upload.id)?.boundAt, first);
  } finally {
    database.close();
  }
});

test('a directory with no row is swept, and a directory with one is kept', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const kept = await uploads.create({kind: 'text', name: 'a.txt', bytes: Buffer.from('a')});
    // What a crash between `mkdir` and `INSERT` leaves behind.
    const orphan = path.join(paths.uploadsDir, 'orphaned-directory');
    await fs.mkdir(orphan, {recursive: true});

    assert.deepEqual(await uploads.sweepOrphanDirectories(), {deleted: 1});
    assert.equal(await pathExists(orphan), false);
    assert.equal(await exists(paths, kept), true);
  } finally {
    database.close();
  }
});

test('a hard-deleted conversation takes its uploads with it', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    const mine = await uploads.create({
      conversationId: 'c1',
      kind: 'text',
      name: 'a.txt',
      bytes: Buffer.from('a'),
    });
    const theirs = await uploads.create({
      conversationId: 'c2',
      kind: 'text',
      name: 'b.txt',
      bytes: Buffer.from('b'),
    });
    uploads.markBound(mine.id);

    await uploads.deleteForConversation('c1');
    assert.equal(uploads.get(mine.id), null);
    assert.equal(await exists(paths, mine), false);
    assert.notEqual(uploads.get(theirs.id), null);
    assert.equal(await exists(paths, theirs), true);
  } finally {
    database.close();
  }
});

test('an upload id that would escape the uploads tree is refused', async () => {
  const {paths, database} = await open();
  try {
    const uploads = new UploadRepository(database, paths);
    // `id` reaches deletion from a route parameter.
    database.connection
      .prepare(
        `INSERT INTO uploads (id, kind, name, size_bytes, storage_path, created_at)
         VALUES (?, 'text', 'evil', 1, 'uploads/x/content', ?)`,
      )
      .run('../../etc', new Date().toISOString());
    await assert.rejects(() => uploads.deleteUnbound('../../etc'), /Refusing to delete/);
  } finally {
    database.close();
  }
});

async function open(): Promise<{paths: AppPaths; database: AppDatabase}> {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  return {paths, database};
}

/** Rewrites `created_at`, because the repository stamps it with the wall clock. */
function backdate(database: AppDatabase, id: string, at: number): void {
  database.connection
    .prepare('UPDATE uploads SET created_at = ? WHERE id = ?')
    .run(new Date(at).toISOString(), id);
}

async function exists(paths: AppPaths, upload: {storagePath: string}): Promise<boolean> {
  return pathExists(path.join(paths.dataDir, ...upload.storagePath.split('/')));
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
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
