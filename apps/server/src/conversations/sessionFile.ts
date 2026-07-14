import fs from 'node:fs/promises';
import type {Database} from 'bun:sqlite';

import type {ConversationStatus} from '../contracts/conversations.ts';
import type {ConversationRow} from './rows';

/**
 * The bound Pi session file: whether it is there, why it is not, and what is left if it
 * is gone.
 *
 * The JSONL *is* the history -- SQLite only holds a projection of it -- so a conversation
 * whose file has vanished is `unavailable`, not empty. **No read path may create a
 * replacement session under the same conversation id**: an ordinary empty chat with a
 * working composer would tell the user their conversation is gone when it is recoverable.
 * That rule is why everything here only ever *reports*. Recovery is three explicit
 * endpoints -- repair (lossless, and it only succeeds if the user put the file back),
 * rebuild (lossy) and delete -- and never a side effect of opening the chat.
 */

export type ConversationDiagnostics = {
  conversationId: string;
  status: ConversationStatus;
  piSessionPath?: string;
  piSessionId?: string;
  exists: boolean;
  reason?: string;
  sizeBytes?: number;
  projectionEntryCount: number;
  attachmentCount: number;
  toolAuditCount: number;
};

export function selectConversationsWithPiSession(db: Database): ConversationRow[] {
  return db
    .prepare(
      `SELECT * FROM conversations
       WHERE status != 'unavailable'
         AND pi_session_path IS NOT NULL`,
    )
    .all() as ConversationRow[];
}

/**
 * Everything the user needs to decide between repairing, rebuilding, and
 * deleting a conversation whose Pi session file went missing.
 */
export async function collectConversationDiagnostics(
  db: Database,
  row: ConversationRow,
): Promise<ConversationDiagnostics> {
  const count = (sql: string): number =>
    (db.prepare(sql).get(row.id) as {total: number} | undefined)?.total ?? 0;

  const reason = await piSessionFileError(row.pi_session_path);
  let sizeBytes: number | undefined;
  if (row.pi_session_path) {
    try {
      sizeBytes = (await fs.stat(row.pi_session_path)).size;
    } catch {
      sizeBytes = undefined;
    }
  }

  return {
    conversationId: row.id,
    status: row.status,
    piSessionPath: row.pi_session_path ?? undefined,
    piSessionId: row.pi_session_id ?? undefined,
    exists: reason == null,
    reason: reason ?? undefined,
    sizeBytes,
    projectionEntryCount: count(
      'SELECT COUNT(*) AS total FROM conversation_entry_projection WHERE conversation_id = ?',
    ),
    attachmentCount: count(
      'SELECT COUNT(*) AS total FROM message_attachments WHERE conversation_id = ?',
    ),
    toolAuditCount: count(
      'SELECT COUNT(*) AS total FROM tool_audit_events WHERE conversation_id = ?',
    ),
  };
}

export async function piSessionFileError(sessionPath: string | null): Promise<string | null> {
  if (!sessionPath) {
    return null;
  }
  try {
    const stat = await fs.stat(sessionPath);
    if (!stat.isFile()) {
      return 'Pi session path is not a file.';
    }
    const firstLine = await readFirstLine(sessionPath);
    if (!firstLine) {
      return 'Pi session file is empty.';
    }
    // These strings reach the user in the repair dialog, so a raw parser message
    // like `Unexpected token 'o', "not-json" is not valid JSON` will not do.
    let header: unknown;
    try {
      header = JSON.parse(firstLine) as unknown;
    } catch {
      return 'Pi session file is not valid JSON.';
    }
    if (
      !header ||
      typeof header !== 'object' ||
      (header as {type?: unknown}).type !== 'session' ||
      typeof (header as {id?: unknown}).id !== 'string'
    ) {
      return 'Pi session file is missing a valid session header.';
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'Pi session file is missing.';
    }
    return error instanceof Error ? error.message : String(error);
  }
}

async function readFirstLine(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = chunk.search(/\r?\n/);
    return (newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk).trim();
  } finally {
    await handle.close();
  }
}
