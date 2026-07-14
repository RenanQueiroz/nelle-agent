import crypto from 'node:crypto';
import type {Database} from 'bun:sqlite';

import type {AttachmentMetadata} from '../contracts/conversations.ts';
import type {ChatAttachmentKind} from '../contracts/contracts.ts';
import {isString, jsonOrNull, parseJson} from './rows';

/**
 * The `message_attachments` table: the bytes a message carried, and the rows that bind
 * them to a Pi entry.
 *
 * An attachment is **uploaded, not embedded** -- the bytes go to `POST /api/uploads`
 * before the message is sent, so a row here starts life unbound (`pi_entry_id IS NULL`)
 * and is bound to the entry the run created. That is what lets a refused message keep its
 * chips: the uploads are still on the server, and only a *sent* message turns them into a
 * message's attachments.
 *
 * This is the only file that writes the table, and it also owns the summary it denormalizes
 * into `conversation_entry_projection.attachment_summary_json` -- a transcript renders
 * chips from that summary, so a write here that skipped it would drop the chips off a
 * message whose files are still on disk.
 */

export type AttachmentRow = {
  id: string;
  conversation_id: string;
  pi_entry_id: string | null;
  upload_id: string | null;
  kind: string;
  name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
  text_content: string | null;
  processing_json: string | null;
  created_at: string;
};

export type CreateAttachmentInput = {
  uploadId: string;
  kind: ChatAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  textContent?: string;
  processing?: unknown;
  createdAt?: string;
};

export type StoredAttachment = AttachmentMetadata & {
  uploadId?: string;
  textContent?: string;
  processing?: unknown;
};

export type ImportedAttachmentInput = {
  piEntryId?: string | null;
  uploadId?: string | null;
  kind: ChatAttachmentKind;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  textContent?: string;
  processing?: unknown;
  createdAt?: string;
};

export function insertPendingAttachments(
  db: Database,
  conversationId: string,
  attachments: CreateAttachmentInput[],
): AttachmentMetadata[] {
  if (attachments.length === 0) {
    return [];
  }
  const created: AttachmentMetadata[] = [];
  const insert = db.prepare(
    `INSERT INTO message_attachments (
       id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
       size_bytes, storage_path, text_content, processing_json, created_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.run('BEGIN');
  try {
    for (const attachment of attachments) {
      const now = attachment.createdAt ?? new Date().toISOString();
      const id = crypto.randomUUID();
      insert.run(
        id,
        conversationId,
        attachment.uploadId,
        attachment.kind,
        attachment.name,
        attachment.mimeType ?? null,
        attachment.sizeBytes ?? null,
        attachment.storagePath ?? null,
        attachment.textContent ?? null,
        jsonOrNull(attachment.processing),
        now,
      );
      created.push({
        id,
        conversationId,
        uploadId: attachment.uploadId,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        storagePath: attachment.storagePath,
        textPreview: attachment.textContent?.slice(0, 240),
        processing: attachment.processing,
        createdAt: now,
      });
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
  return created;
}

export function copyAttachmentsForEntries(
  db: Database,
  sourceConversationId: string,
  targetConversationId: string,
  piEntryIds: string[],
): AttachmentMetadata[] {
  if (piEntryIds.length === 0) {
    return [];
  }
  const placeholders = piEntryIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
              size_bytes, storage_path, text_content, processing_json, created_at
       FROM message_attachments
       WHERE conversation_id = ? AND pi_entry_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all(sourceConversationId, ...piEntryIds) as AttachmentRow[];
  if (rows.length === 0) {
    return [];
  }

  const now = new Date().toISOString();
  const copied: AttachmentMetadata[] = [];
  const insert = db.prepare(
    `INSERT INTO message_attachments (
       id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
       size_bytes, storage_path, text_content, processing_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.run('BEGIN');
  try {
    for (const row of rows) {
      const id = crypto.randomUUID();
      insert.run(
        id,
        targetConversationId,
        row.pi_entry_id,
        row.upload_id,
        row.kind,
        row.name,
        row.mime_type,
        row.size_bytes,
        row.storage_path,
        row.text_content,
        row.processing_json,
        now,
      );
      copied.push({
        ...mapAttachmentRow({
          ...row,
          id,
          conversation_id: targetConversationId,
          created_at: now,
        }),
      });
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }

  for (const piEntryId of new Set(rows.map(row => row.pi_entry_id).filter(id => id != null))) {
    refreshAttachmentSummary(db, targetConversationId, piEntryId);
  }
  return copied;
}

export function refreshAttachmentSummary(
  db: Database,
  conversationId: string,
  piEntryId: string,
): void {
  const attachments = selectAttachmentsForEntry(db, conversationId, piEntryId);
  db.prepare(
    `UPDATE conversation_entry_projection
     SET attachment_summary_json = ?
     WHERE conversation_id = ? AND pi_entry_id = ?`,
  ).run(jsonOrNull(summarizeAttachments(attachments)), conversationId, piEntryId);
}

export function bindAttachmentsToEntry(
  db: Database,
  conversationId: string,
  uploadIds: string[],
  piEntryId: string,
): AttachmentMetadata[] {
  if (uploadIds.length === 0) {
    return [];
  }
  const placeholders = uploadIds.map(() => '?').join(', ');
  db.prepare(
    `UPDATE message_attachments
     SET pi_entry_id = ?
     WHERE conversation_id = ? AND upload_id IN (${placeholders})`,
  ).run(piEntryId, conversationId, ...uploadIds);

  refreshAttachmentSummary(db, conversationId, piEntryId);
  return selectAttachmentsForEntry(db, conversationId, piEntryId);
}

export function insertImportedAttachments(
  db: Database,
  conversationId: string,
  attachments: ImportedAttachmentInput[],
): AttachmentMetadata[] {
  if (attachments.length === 0) {
    return [];
  }
  const created: AttachmentMetadata[] = [];
  const insert = db.prepare(
    `INSERT INTO message_attachments (
       id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
       size_bytes, storage_path, text_content, processing_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.run('BEGIN');
  try {
    for (const attachment of attachments) {
      const now = attachment.createdAt ?? new Date().toISOString();
      const id = crypto.randomUUID();
      insert.run(
        id,
        conversationId,
        attachment.piEntryId ?? null,
        attachment.uploadId ?? null,
        attachment.kind,
        attachment.name,
        attachment.mimeType ?? null,
        attachment.sizeBytes ?? null,
        attachment.storagePath ?? null,
        attachment.textContent ?? null,
        jsonOrNull(attachment.processing),
        now,
      );
      created.push({
        id,
        conversationId,
        piEntryId: attachment.piEntryId ?? undefined,
        uploadId: attachment.uploadId ?? undefined,
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        storagePath: attachment.storagePath,
        textPreview: attachment.textContent?.slice(0, 240),
        processing: attachment.processing,
        createdAt: now,
      });
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }

  for (const piEntryId of new Set(attachments.map(item => item.piEntryId).filter(isString))) {
    refreshAttachmentSummary(db, conversationId, piEntryId);
  }
  return created;
}

/**
 * Repoints attachment rows at the entry ids a rebuilt Pi session handed out.
 *
 * Rebuilding writes fresh Pi entries, so every `pi_entry_id` sidecar rows hold
 * is stale. Attachments would otherwise stay bound to entries that no longer
 * exist and quietly vanish from the transcript.
 */
export function remapAttachmentEntryIds(
  db: Database,
  conversationId: string,
  mapping: Map<string, string>,
): void {
  const statement = db.prepare(
    'UPDATE message_attachments SET pi_entry_id = ? WHERE conversation_id = ? AND pi_entry_id = ?',
  );
  db.run('BEGIN');
  try {
    for (const [previousId, nextId] of mapping) {
      statement.run(nextId, conversationId, previousId);
    }
    db.run('COMMIT');
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

/**
 * One attachment by id, for serving its bytes.
 *
 * The id is the only thing the client has: a transcript renders what the snapshot
 * gave it, and the snapshot carries attachment metadata but not the bytes -- the
 * bytes are on the server, and on a phone they always will be.
 */
export function selectAttachmentById(db: Database, id: string): AttachmentMetadata | null {
  const row = db
    .prepare(
      `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
              size_bytes, storage_path, text_content, processing_json, created_at
       FROM message_attachments
       WHERE id = ?`,
    )
    .get(id) as AttachmentRow | undefined;
  return row ? mapAttachmentRow(row) : null;
}

export function selectAttachments(db: Database, conversationId: string): StoredAttachment[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
              size_bytes, storage_path, text_content, processing_json, created_at
       FROM message_attachments
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as AttachmentRow[];

  return rows.map(mapAttachmentRow);
}

export function selectAttachmentsForEntry(
  db: Database,
  conversationId: string,
  piEntryId: string,
): StoredAttachment[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, pi_entry_id, upload_id, kind, name, mime_type,
              size_bytes, storage_path, text_content, processing_json, created_at
       FROM message_attachments
       WHERE conversation_id = ? AND pi_entry_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId, piEntryId) as AttachmentRow[];

  return rows.map(mapAttachmentRow);
}

export function isAttachmentStorageReferencedByOtherConversation(
  db: Database,
  storagePath: string,
  conversationId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM message_attachments
       WHERE storage_path = ? AND conversation_id != ?`,
    )
    .get(storagePath, conversationId) as {count: number};
  return row.count > 0;
}

function mapAttachmentRow(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    piEntryId: row.pi_entry_id ?? undefined,
    uploadId: row.upload_id ?? undefined,
    kind: normalizeAttachmentKind(row.kind),
    name: row.name,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    storagePath: row.storage_path ?? undefined,
    textPreview: row.text_content?.slice(0, 240),
    textContent: row.text_content ?? undefined,
    processing: parseJson(row.processing_json),
    createdAt: row.created_at,
  };
}

function normalizeAttachmentKind(kind: string): ChatAttachmentKind {
  if (kind === 'pdf' || kind === 'image' || kind === 'text') {
    return kind;
  }
  return 'text';
}

function summarizeAttachments(attachments: AttachmentMetadata[]): unknown {
  return {
    count: attachments.length,
    items: attachments.map(attachment => ({
      id: attachment.id,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    })),
  };
}
