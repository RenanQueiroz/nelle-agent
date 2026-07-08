import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

import type {AppPaths} from './paths';

type Migration = {
  version: number;
  name: string;
  checksum: string;
  sql: string;
  isApplied?: (db: DatabaseSync) => boolean;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_conversation_schema',
    checksum: '2026-07-08-initial-conversation-schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_source TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        pi_session_path TEXT UNIQUE,
        pi_session_id TEXT,
        active_leaf_pi_entry_id TEXT,
        last_synced_pi_entry_id TEXT,
        default_model_id TEXT,
        parent_conversation_id TEXT,
        forked_from_pi_entry_id TEXT,
        fork_kind TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS conversations_pi_session_id_unique
        ON conversations(pi_session_id)
        WHERE pi_session_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS conversations_pinned_updated_idx
        ON conversations(pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS conversations_status_updated_idx
        ON conversations(status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS conversation_entry_projection (
        conversation_id TEXT NOT NULL,
        pi_entry_id TEXT NOT NULL,
        parent_pi_entry_id TEXT,
        entry_type TEXT NOT NULL,
        role TEXT,
        text_preview TEXT,
        created_at TEXT NOT NULL,
        model_id TEXT,
        model_runtime_id TEXT,
        model_alias_snapshot TEXT,
        performance_json TEXT,
        tool_calls_json TEXT,
        attachment_summary_json TEXT,
        regenerates_pi_entry_id TEXT,
        display_group_id TEXT,
        PRIMARY KEY (conversation_id, pi_entry_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS conversation_entry_projection_parent_idx
        ON conversation_entry_projection(conversation_id, parent_pi_entry_id);
      CREATE INDEX IF NOT EXISTS conversation_entry_projection_created_idx
        ON conversation_entry_projection(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS conversation_entry_projection_display_group_idx
        ON conversation_entry_projection(conversation_id, display_group_id);

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        pi_entry_id TEXT,
        upload_id TEXT,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        storage_path TEXT,
        text_content TEXT,
        processing_json TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS message_attachments_conversation_entry_idx
        ON message_attachments(conversation_id, pi_entry_id);

      CREATE TABLE IF NOT EXISTS model_cache (
        section_id TEXT PRIMARY KEY,
        hf_repo TEXT,
        alias TEXT,
        router_model_id TEXT,
        status TEXT,
        modalities_json TEXT,
        context_window INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tool_audit_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        pi_entry_id TEXT,
        pi_tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS tool_audit_events_started_idx
        ON tool_audit_events(conversation_id, started_at);
      CREATE INDEX IF NOT EXISTS tool_audit_events_tool_call_idx
        ON tool_audit_events(conversation_id, pi_tool_call_id);
    `,
  },
  {
    version: 2,
    name: 'conversation_context_usage_cache',
    checksum: '2026-07-08-conversation-context-usage-cache',
    sql: `
      ALTER TABLE conversations ADD COLUMN context_usage_json TEXT;
    `,
    isApplied: db => tableHasColumn(db, 'conversations', 'context_usage_json'),
  },
];

export class AppDatabase {
  #db: DatabaseSync | null = null;
  #migrationBackupPath: string | null = null;

  constructor(private readonly paths: AppPaths) {}

  async open(): Promise<DatabaseSync> {
    if (this.#db) {
      return this.#db;
    }

    await fs.mkdir(path.dirname(this.paths.settingsDbPath), {recursive: true});
    const shouldBackupExistingDatabase = await fileHasContents(this.paths.settingsDbPath);
    this.#db = new DatabaseSync(this.paths.settingsDbPath);
    this.#db.exec('PRAGMA foreign_keys = ON;');
    await this.runMigrations(shouldBackupExistingDatabase);
    this.#db.exec('PRAGMA journal_mode = WAL;');
    this.tryCreateSearchTable();
    return this.#db;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#migrationBackupPath = null;
  }

  get connection(): DatabaseSync {
    return this.requireDb();
  }

  private async runMigrations(shouldBackupExistingDatabase: boolean): Promise<void> {
    const db = this.requireDb();
    const hasMigrationTable = tableExists(db, 'schema_migrations');
    if (!hasMigrationTable) {
      await this.ensureMigrationBackup(shouldBackupExistingDatabase);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      );
    `);
    const getMigration = db.prepare('SELECT checksum FROM schema_migrations WHERE version = ?');
    const insertMigration = db.prepare(
      'INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
    );

    for (const migration of MIGRATIONS) {
      const existing = getMigration.get(migration.version) as {checksum: string} | undefined;
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          await this.ensureMigrationBackup(shouldBackupExistingDatabase);
          throw new Error(
            `Migration checksum mismatch for ${migration.version} ${migration.name}.`,
          );
        }
        continue;
      }

      await this.ensureMigrationBackup(shouldBackupExistingDatabase);
      db.exec('BEGIN');
      try {
        if (!migration.isApplied?.(db)) {
          db.exec(migration.sql);
        }
        insertMigration.run(
          migration.version,
          migration.name,
          new Date().toISOString(),
          migration.checksum,
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  private async ensureMigrationBackup(
    shouldBackupExistingDatabase: boolean,
  ): Promise<string | null> {
    if (!shouldBackupExistingDatabase) {
      return null;
    }
    if (this.#migrationBackupPath) {
      return this.#migrationBackupPath;
    }

    const backupDir = path.join(this.paths.dataDir, 'backups');
    await fs.mkdir(backupDir, {recursive: true});
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `settings.sqlite.${timestamp}.${randomUUID()}.bak`);
    this.requireDb().exec(`VACUUM INTO ${sqlStringLiteral(backupPath)}`);
    this.#migrationBackupPath = backupPath;
    return backupPath;
  }

  private tryCreateSearchTable(): void {
    const db = this.requireDb();
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search
          USING fts5(conversation_id UNINDEXED, title);
      `);
    } catch {
      // Some embedded SQLite builds omit FTS5. The repository falls back to
      // indexed conversation rows until the packaging matrix is verified.
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.#db) {
      throw new Error('Database is not open.');
    }
    return this.#db;
  }
}

async function fileHasContents(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as {name: string} | undefined;
  return row?.name === tableName;
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${sqlIdentifier(tableName)})`)
    .all()
    .some(column => (column as {name?: string}).name === columnName);
}

function sqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
