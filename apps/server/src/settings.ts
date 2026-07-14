import {
  SETTINGS_REGISTRY,
  coerceSettingsValues,
  findSettingsGroup,
  type SettingsGroup,
  type SettingsValues,
} from './contracts/settings.ts';
import type {AppDatabase} from './database';

/**
 * Server-owned behaviour settings, one `settings` table row per registry group.
 *
 * Shaped like `PreferencesRepository`, which is the pattern that already works.
 * The difference is that nothing here is hand-written per group: the registry
 * says what a group holds, and this reads and writes exactly that.
 */
export class SettingsRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly registry: readonly SettingsGroup[] = SETTINGS_REGISTRY,
  ) {}

  get groups(): readonly SettingsGroup[] {
    return this.registry;
  }

  /** Effective values: what is stored, with every absent field at its default. */
  getGroup(slug: string): SettingsValues {
    return coerceSettingsValues(this.requireGroup(slug), this.readStored(slug));
  }

  /**
   * The same, for a caller that can go on without the group. Only a registry
   * that does not declare it -- a test fixture -- answers `undefined`, and such
   * a caller falls back to that feature's own defaults.
   */
  tryGetGroup(slug: string): SettingsValues | undefined {
    const group = findSettingsGroup(slug, this.registry);
    return group ? coerceSettingsValues(group, this.readStored(slug)) : undefined;
  }

  /**
   * Merges a validated patch over the current values and persists the group.
   *
   * A key the registry does not declare is written back untouched. It cannot
   * have arrived through `PATCH`, which is strict, so it came from a server that
   * knew a field this one does not -- a downgrade, or a client's row written by
   * a newer build. Eating it would make the setting vanish on the way back up,
   * and it costs nothing to carry.
   */
  updateGroup(slug: string, patch: SettingsValues): SettingsValues {
    const group = this.requireGroup(slug);
    // Declared fields are re-written from their effective values, which heals a
    // stored value that no longer parses. Everything else is passed through.
    const effective = coerceSettingsValues(group, this.readStored(slug));
    const persisted = {...this.readStored(slug), ...effective, ...patch};
    this.database.connection
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(slug, JSON.stringify(persisted), new Date().toISOString());
    return {...effective, ...patch};
  }

  /** The raw row, or `{}` when it is absent or unreadable. */
  private readStored(slug: string): Record<string, unknown> {
    const row = this.database.connection
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(slug) as {value_json: string} | undefined;
    if (!row) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      // A row written by a future schema, or a truncated write. Defaults are a
      // better answer than a 500 on every settings read.
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private requireGroup(slug: string): SettingsGroup {
    const group = findSettingsGroup(slug, this.registry);
    if (!group) {
      // Routes are registered from the registry, so this is a programming error
      // rather than anything a request can provoke.
      throw new Error(`Unknown settings group: ${slug}`);
    }
    return group;
  }
}
