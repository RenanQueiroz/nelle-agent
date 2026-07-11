import crypto from 'node:crypto';

import type {AppDatabase} from './database';

const HOST_TOOLS_SETTINGS_KEY = 'hostTools';

export type HostToolSettings = {
  enabled: boolean;
  acknowledged: boolean;
  updatedAt: string;
};

export type ToolAuditEvent = {
  id: string;
  conversationId: string;
  piEntryId?: string;
  piToolCallId: string;
  toolName: string;
  status: 'running' | 'complete' | 'error';
  input: unknown;
  output?: unknown;
  error?: unknown;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
};

export class HostToolRepository {
  constructor(private readonly database: AppDatabase) {}

  getSettings(): HostToolSettings {
    const row = this.database.connection
      .prepare('SELECT value_json, updated_at FROM settings WHERE key = ?')
      .get(HOST_TOOLS_SETTINGS_KEY) as {value_json: string; updated_at: string} | undefined;
    if (!row) {
      return defaultHostToolSettings();
    }
    const parsed = parseSettings(row.value_json);
    return {
      enabled: parsed.enabled,
      acknowledged: parsed.acknowledged,
      updatedAt: row.updated_at,
    };
  }

  updateSettings(input: {enabled?: boolean; acknowledged?: boolean}): HostToolSettings {
    const current = this.getSettings();
    const next: HostToolSettings = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      acknowledged: input.acknowledged ?? current.acknowledged,
      updatedAt: new Date().toISOString(),
    };
    if (next.enabled && !next.acknowledged) {
      throw new Error('Host tools must be acknowledged before they can be enabled.');
    }
    this.database.connection
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        HOST_TOOLS_SETTINGS_KEY,
        JSON.stringify({enabled: next.enabled, acknowledged: next.acknowledged}),
        next.updatedAt,
      );
    return next;
  }

  areToolsEnabled(): boolean {
    return this.getSettings().enabled;
  }

  recordToolStart(input: {
    conversationId: string;
    piEntryId?: string;
    piToolCallId: string;
    toolName: string;
    args: unknown;
    startedAt?: Date;
  }): ToolAuditEvent {
    const startedAt = input.startedAt ?? new Date();
    const event: ToolAuditEvent = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      piEntryId: input.piEntryId,
      piToolCallId: input.piToolCallId,
      toolName: input.toolName,
      status: 'running',
      input: input.args ?? null,
      startedAt: startedAt.toISOString(),
    };
    this.database.connection
      .prepare(
        `INSERT INTO tool_audit_events (
           id, conversation_id, pi_entry_id, pi_tool_call_id, tool_name, status,
           input_json, started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.conversationId,
        event.piEntryId ?? null,
        event.piToolCallId,
        event.toolName,
        event.status,
        stringifyJson(event.input),
        event.startedAt,
      );
    return event;
  }

  recordToolEnd(input: {
    conversationId: string;
    piToolCallId: string;
    toolName: string;
    args: unknown;
    status: 'complete' | 'error';
    output?: unknown;
    error?: unknown;
    completedAt?: Date;
    durationMs?: number;
  }): ToolAuditEvent {
    const completedAt = input.completedAt ?? new Date();
    const existing = this.database.connection
      .prepare(
        `SELECT *
         FROM tool_audit_events
         WHERE conversation_id = ? AND pi_tool_call_id = ?
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(input.conversationId, input.piToolCallId) as ToolAuditRow | undefined;
    if (!existing) {
      const startedAt = new Date(completedAt.getTime() - Math.max(input.durationMs ?? 0, 0));
      const started = this.recordToolStart({
        conversationId: input.conversationId,
        piToolCallId: input.piToolCallId,
        toolName: input.toolName,
        args: input.args,
        startedAt,
      });
      this.updateToolEnd(started.id, input, completedAt);
      return this.getAuditEvent(started.id) ?? started;
    }
    this.updateToolEnd(existing.id, input, completedAt);
    return this.getAuditEvent(existing.id) ?? mapToolAuditRow(existing);
  }

  listAuditEvents(conversationId: string): ToolAuditEvent[] {
    const rows = this.database.connection
      .prepare(
        `SELECT *
         FROM tool_audit_events
         WHERE conversation_id = ?
         ORDER BY started_at ASC`,
      )
      .all(conversationId) as ToolAuditRow[];
    return rows.map(mapToolAuditRow);
  }

  deleteAuditEventsForConversation(conversationId: string): void {
    this.database.connection
      .prepare('DELETE FROM tool_audit_events WHERE conversation_id = ?')
      .run(conversationId);
  }

  deleteAllAuditEvents(): void {
    this.database.connection.run('DELETE FROM tool_audit_events;');
  }

  private updateToolEnd(
    id: string,
    input: {
      status: 'complete' | 'error';
      output?: unknown;
      error?: unknown;
      completedAt?: Date;
      durationMs?: number;
    },
    completedAt: Date,
  ): void {
    this.database.connection
      .prepare(
        `UPDATE tool_audit_events
         SET status = ?, output_json = ?, error_json = ?, completed_at = ?,
             duration_ms = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.output === undefined ? null : stringifyJson(input.output),
        input.error === undefined ? null : stringifyJson(input.error),
        completedAt.toISOString(),
        input.durationMs ?? null,
        id,
      );
  }

  private getAuditEvent(id: string): ToolAuditEvent | null {
    const row = this.database.connection
      .prepare('SELECT * FROM tool_audit_events WHERE id = ?')
      .get(id) as ToolAuditRow | undefined;
    return row ? mapToolAuditRow(row) : null;
  }
}

type ToolAuditRow = {
  id: string;
  conversation_id: string;
  pi_entry_id: string | null;
  pi_tool_call_id: string;
  tool_name: string;
  status: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
};

function defaultHostToolSettings(): HostToolSettings {
  return {
    enabled: false,
    acknowledged: false,
    updatedAt: new Date(0).toISOString(),
  };
}

function parseSettings(text: string): Pick<HostToolSettings, 'enabled' | 'acknowledged'> {
  try {
    const parsed = JSON.parse(text) as {enabled?: unknown; acknowledged?: unknown};
    return {
      enabled: parsed.enabled === true,
      acknowledged: parsed.acknowledged === true,
    };
  } catch {
    return {enabled: false, acknowledged: false};
  }
}

function mapToolAuditRow(row: ToolAuditRow): ToolAuditEvent {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    piEntryId: row.pi_entry_id ?? undefined,
    piToolCallId: row.pi_tool_call_id,
    toolName: row.tool_name,
    status: normalizeToolStatus(row.status),
    input: parseJson(row.input_json),
    output: row.output_json == null ? undefined : parseJson(row.output_json),
    error: row.error_json == null ? undefined : parseJson(row.error_json),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
  };
}

function normalizeToolStatus(status: string): ToolAuditEvent['status'] {
  if (status === 'complete' || status === 'error') {
    return status;
  }
  return 'running';
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
