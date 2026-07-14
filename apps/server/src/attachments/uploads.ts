import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {AttachmentKind} from '../contracts/attachmentRules.ts';
import type {AppDatabase} from '../db/database';
import type {AppPaths} from '../lib/paths';

/** An unbound upload is a draft the user never sent. It expires. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Startup sweeps once; a long-lived server sweeps hourly. */
export const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export type Upload = {
  id: string;
  conversationId?: string;
  kind: AttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes: number;
  /** Relative to `dataDir`, in POSIX form, like attachment storage paths. */
  storagePath: string;
  /**
   * Extracted text for `text` uploads, and for `pdf` uploads that have a text
   * layer. A scanned PDF has none, and is read as page images instead.
   */
  textContent?: string;
  /** PDFs only. Their page images are what a scan costs the context. */
  pageCount?: number;
  createdAt: string;
  /** Set when a message claimed this upload. A bound upload is never swept. */
  boundAt?: string;
};

type UploadRow = {
  id: string;
  conversation_id: string | null;
  kind: string;
  name: string;
  mime_type: string | null;
  size_bytes: number;
  storage_path: string;
  text_content: string | null;
  page_count: number | null;
  created_at: string;
  bound_at: string | null;
};

/**
 * Draft attachments, stored under `.nelle/uploads/<uploadId>/` until a message
 * claims them.
 *
 * The content-addressed `.nelle/attachments/` tree holds only what was sent, and
 * is swept against the attachment metadata rows. Uploads need their own tree and
 * their own sweep, because an upload nobody sends is referenced by nothing.
 */
export class UploadRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly paths: AppPaths,
  ) {}

  async create(input: {
    conversationId?: string;
    kind: AttachmentKind;
    name: string;
    mimeType?: string;
    bytes: Buffer;
    textContent?: string;
    pageCount?: number;
  }): Promise<Upload> {
    const id = crypto.randomUUID();
    const directory = path.join(this.paths.uploadsDir, id);
    await fs.mkdir(directory, {recursive: true});
    const filePath = path.join(directory, 'content');
    await fs.writeFile(filePath, input.bytes);

    const upload: Upload = {
      id,
      conversationId: input.conversationId,
      kind: input.kind,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      storagePath: toStoragePath(this.paths.dataDir, filePath),
      textContent: input.textContent,
      pageCount: input.pageCount,
      createdAt: new Date().toISOString(),
    };

    this.database.connection
      .prepare(
        `INSERT INTO uploads (
           id, conversation_id, kind, name, mime_type, size_bytes,
           storage_path, text_content, page_count, created_at, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        upload.id,
        upload.conversationId ?? null,
        upload.kind,
        upload.name,
        upload.mimeType ?? null,
        upload.sizeBytes,
        upload.storagePath,
        upload.textContent ?? null,
        upload.pageCount ?? null,
        upload.createdAt,
      );
    return upload;
  }

  get(id: string): Upload | null {
    const row = this.database.connection.prepare('SELECT * FROM uploads WHERE id = ?').get(id) as
      | UploadRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** Reads the bytes back for a send, or for a PDF the client asked to render. */
  async readBytes(upload: Upload): Promise<Buffer> {
    return fs.readFile(path.join(this.paths.dataDir, ...upload.storagePath.split('/')));
  }

  markBound(id: string): void {
    this.database.connection
      .prepare('UPDATE uploads SET bound_at = ? WHERE id = ? AND bound_at IS NULL')
      .run(new Date().toISOString(), id);
  }

  /** Drops an unsent draft: the row and its bytes. A bound upload is refused. */
  async deleteUnbound(id: string): Promise<boolean> {
    const upload = this.get(id);
    if (!upload || upload.boundAt) {
      return false;
    }
    this.database.connection.prepare('DELETE FROM uploads WHERE id = ?').run(id);
    await this.removeDirectory(id);
    return true;
  }

  /** Bound uploads whose conversation is being hard-deleted. */
  async deleteForConversation(conversationId: string): Promise<void> {
    const rows = this.database.connection
      .prepare('SELECT id FROM uploads WHERE conversation_id = ?')
      .all(conversationId) as Array<{id: string}>;
    this.database.connection
      .prepare('DELETE FROM uploads WHERE conversation_id = ?')
      .run(conversationId);
    for (const row of rows) {
      await this.removeDirectory(row.id);
    }
  }

  /**
   * Deletes unbound uploads older than the TTL. A bound upload belongs to a
   * message and is swept with its conversation, never on a timer.
   */
  async sweepExpired(now: number = Date.now()): Promise<{deleted: number}> {
    const cutoff = new Date(now - UPLOAD_TTL_MS).toISOString();
    const rows = this.database.connection
      .prepare('SELECT id FROM uploads WHERE bound_at IS NULL AND created_at < ?')
      .all(cutoff) as Array<{id: string}>;
    if (rows.length === 0) {
      return {deleted: 0};
    }
    const statement = this.database.connection.prepare('DELETE FROM uploads WHERE id = ?');
    for (const row of rows) {
      statement.run(row.id);
      await this.removeDirectory(row.id);
    }
    return {deleted: rows.length};
  }

  /**
   * Removes upload directories with no row, which is what a crash between
   * `mkdir` and `INSERT` leaves behind.
   */
  async sweepOrphanDirectories(): Promise<{deleted: number}> {
    let entries;
    try {
      entries = await fs.readdir(this.paths.uploadsDir, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {deleted: 0};
      }
      throw error;
    }
    const known = new Set(
      (this.database.connection.prepare('SELECT id FROM uploads').all() as Array<{id: string}>).map(
        row => row.id,
      ),
    );
    let deleted = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && !known.has(entry.name)) {
        await this.removeDirectory(entry.name);
        deleted += 1;
      }
    }
    return {deleted};
  }

  private async removeDirectory(id: string): Promise<void> {
    // `id` is a UUID we generated, but it reaches this method from a route
    // parameter. Refuse anything that would escape the uploads tree.
    const directory = path.resolve(this.paths.uploadsDir, id);
    const root = path.resolve(this.paths.uploadsDir);
    if (directory === root || !directory.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to delete an upload path outside ${root}: ${directory}`);
    }
    await fs.rm(directory, {recursive: true, force: true});
  }
}

function toStoragePath(dataDir: string, filePath: string): string {
  return path.relative(path.resolve(dataDir), path.resolve(filePath)).split(path.sep).join('/');
}

function mapRow(row: UploadRow): Upload {
  return {
    id: row.id,
    conversationId: row.conversation_id ?? undefined,
    kind: row.kind as AttachmentKind,
    name: row.name,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    textContent: row.text_content ?? undefined,
    pageCount: row.page_count ?? undefined,
    createdAt: row.created_at,
    boundAt: row.bound_at ?? undefined,
  };
}
