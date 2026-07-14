import type {Database} from 'bun:sqlite';

import type {ConversationRow} from './rows';

/**
 * Finding conversations: one page of the sidebar, the count behind it, and the FTS
 * index the search box reads.
 *
 * The keyset walk and the FTS filter are the **same statement** -- FTS5 is only ever a
 * filter, and the ordering always comes from `conversations` -- so they cannot be split
 * into two files without splitting one query in half. Search is a server query and never
 * a filter over the loaded page: the sidebar holds a window onto the list, so filtering
 * it client-side would report "no matching chats" for every conversation the user has
 * not scrolled to.
 */

/**
 * Keyset cursor over `(updated_at, id)`.
 *
 * An offset cursor would skip rows: answering a chat bumps its `updated_at`,
 * which reorders the very list being paged through. The last row of the previous
 * page is a stable place to resume from, and `id` breaks ties between two
 * conversations updated in the same millisecond.
 */
export type ConversationCursor = {updatedAt: string; id: string};

/** Pinned rows are few by construction, but refuse to unbound the query. */
export const MAX_PINNED_CONVERSATIONS = 200;

export function encodeCursor(cursor: ConversationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string | undefined): ConversationCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ConversationCursor).updatedAt === 'string' &&
      typeof (parsed as ConversationCursor).id === 'string'
    ) {
      return parsed as ConversationCursor;
    }
  } catch {
    // A cursor is opaque to callers, so a malformed one is indistinguishable
    // from a stale one. Start over rather than failing the list request.
  }
  return null;
}

/**
 * One page of rows from a single pinned group, newest first.
 *
 * FTS5 is only ever a filter here; the ordering always comes from
 * `conversations`. Paginating by FTS `rank` would overlap pages, because rank
 * shifts as rows are inserted into the index.
 */
export function queryConversationRows(
  db: Database,
  input: {
    search?: string;
    pinned: boolean;
    limit: number;
    cursor?: ConversationCursor | null;
  },
): ConversationRow[] {
  const conditions = ['conversations.pinned = ?'];
  const params: (string | number)[] = [input.pinned ? 1 : 0];

  if (input.cursor) {
    conditions.push('(conversations.updated_at, conversations.id) < (?, ?)');
    params.push(input.cursor.updatedAt, input.cursor.id);
  }

  const tail = `ORDER BY conversations.updated_at DESC, conversations.id DESC LIMIT ?`;

  if (input.search && hasConversationSearch(db)) {
    try {
      return db
        .prepare(
          `SELECT conversations.*
           FROM conversation_search
           JOIN conversations ON conversations.id = conversation_search.conversation_id
           WHERE conversation_search MATCH ? AND ${conditions.join(' AND ')}
           ${tail}`,
        )
        .all(input.search, ...params, input.limit) as ConversationRow[];
    } catch {
      // FTS query syntax is stricter than ordinary user search input. Fall
      // back to LIKE rather than failing the list endpoint.
    }
  }

  if (input.search) {
    conditions.push(`conversations.title LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(input.search)}%`);
  }

  return db
    .prepare(`SELECT conversations.* FROM conversations WHERE ${conditions.join(' AND ')} ${tail}`)
    .all(...params, input.limit) as ConversationRow[];
}

/**
 * How many conversations match, across every page.
 *
 * The sidebar shows a window; "512 conversations stored locally" must count
 * the ones that were never fetched.
 */
export function countConversationRows(db: Database, search: string | undefined): number {
  if (search && hasConversationSearch(db)) {
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total
           FROM conversation_search
           JOIN conversations ON conversations.id = conversation_search.conversation_id
           WHERE conversation_search MATCH ?`,
        )
        .get(search) as {total: number};
      return row.total;
    } catch {
      // Same stricter-syntax fallback as the page query below.
    }
  }
  if (search) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total FROM conversations
         WHERE title LIKE ? ESCAPE '\\'`,
      )
      .get(`%${escapeLike(search)}%`) as {total: number};
    return row.total;
  }
  const row = db.prepare('SELECT COUNT(*) AS total FROM conversations').get() as {total: number};
  return row.total;
}

export function upsertConversationSearch(
  db: Database,
  conversationId: string,
  title: string,
): void {
  if (!hasConversationSearch(db)) {
    return;
  }
  db.prepare('DELETE FROM conversation_search WHERE conversation_id = ?').run(conversationId);
  db.prepare('INSERT INTO conversation_search(conversation_id, title) VALUES (?, ?)').run(
    conversationId,
    title,
  );
}

export function hasConversationSearch(db: Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conversation_search'")
    .get() as {name: string} | undefined;
  return row != null;
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, character => `\\${character}`);
}
