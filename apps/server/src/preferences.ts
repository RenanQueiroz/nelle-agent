import {
  DEFAULT_DISPLAY_PREFERENCES,
  DISPLAY_PREFERENCE_KEYS,
  readDisplayPreferences,
  type DisplayPreferences,
} from '../../../packages/shared/src/displayPreferences.ts';
import type {AppDatabase} from './database';

const PREFERENCES_SETTINGS_KEY = 'preferences';

export type Preferences = DisplayPreferences & {
  /** Model ids the user pinned to the top of the composer's model selector. */
  favoriteModelIds: string[];
};

export type PreferencesPatch = Partial<Preferences>;

/**
 * User preferences that should follow the user between clients.
 *
 * Favorites lived in the browser's `localStorage`, so a phone started with an
 * empty list and could never be told about the desktop's. The display toggles
 * join them for the same reason: only their *storage* is server-side, and the
 * client still decides what a collapsed thinking block looks like. Anything
 * genuinely local -- sidebar collapse, the open settings section, drafts --
 * stays in the client's own stores.
 */
export class PreferencesRepository {
  constructor(private readonly database: AppDatabase) {}

  /**
   * `knownModelIds` filters out favorites whose model has since been removed
   * from `models.ini`. The filter is not persisted: a model that reappears
   * brings its favorite back, and a transient read never destroys the set.
   */
  getPreferences(knownModelIds?: Iterable<string>): Preferences {
    const stored = this.readStored();
    if (!knownModelIds) {
      return stored;
    }
    const known = new Set(knownModelIds);
    return {...stored, favoriteModelIds: stored.favoriteModelIds.filter(id => known.has(id))};
  }

  /**
   * Merges a patch over the raw stored row, not over the parsed one.
   *
   * A key this build does not know -- a preference a newer client wrote -- is
   * written back untouched. An older server must not eat a newer client's
   * setting; there is no migration path through a phone's cache.
   */
  updatePreferences(input: PreferencesPatch): Preferences {
    const raw = this.readRaw();
    const current = this.readStored();
    const next: Record<string, unknown> = {...raw, ...current};
    if (input.favoriteModelIds) {
      next.favoriteModelIds = dedupe(input.favoriteModelIds);
    }
    for (const key of DISPLAY_PREFERENCE_KEYS) {
      if (typeof input[key] === 'boolean') {
        next[key] = input[key];
      }
    }
    this.database.connection
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(PREFERENCES_SETTINGS_KEY, JSON.stringify(next), new Date().toISOString());
    return this.readStored();
  }

  private readStored(): Preferences {
    const raw = this.readRaw();
    const favoriteModelIds = Array.isArray(raw.favoriteModelIds)
      ? dedupe(raw.favoriteModelIds.filter((id): id is string => typeof id === 'string'))
      : [];
    return {...readDisplayPreferences(raw), favoriteModelIds};
  }

  /** The row as written, or `{}`. Never parsed, so unknown keys survive. */
  private readRaw(): Record<string, unknown> {
    const row = this.database.connection
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(PREFERENCES_SETTINGS_KEY) as {value_json: string} | undefined;
    if (!row) {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(row.value_json);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // A row written by a future schema. Preferences are not worth failing over.
      return {};
    }
  }
}

export {DEFAULT_DISPLAY_PREFERENCES};

/** Order is the user's; the first occurrence of an id wins. */
function dedupe(modelIds: string[]): string[] {
  return [...new Set(modelIds)];
}
