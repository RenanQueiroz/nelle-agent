import type {AppDatabase} from './database';

const PREFERENCES_SETTINGS_KEY = 'preferences';

export type Preferences = {
  /** Model ids the user pinned to the top of the composer's model selector. */
  favoriteModelIds: string[];
};

/**
 * User preferences that should follow the user between clients.
 *
 * Favorites lived in the browser's `localStorage`, so a phone started with an
 * empty list and could never be told about the desktop's. Anything genuinely
 * local -- sidebar collapse, the open settings section, drafts -- stays in the
 * client's own stores.
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
    return {favoriteModelIds: stored.favoriteModelIds.filter(id => known.has(id))};
  }

  updatePreferences(input: {favoriteModelIds?: string[]}): Preferences {
    const current = this.readStored();
    const next: Preferences = {
      favoriteModelIds: dedupe(input.favoriteModelIds ?? current.favoriteModelIds),
    };
    this.database.connection
      .prepare(
        `INSERT INTO settings(key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(PREFERENCES_SETTINGS_KEY, JSON.stringify(next), new Date().toISOString());
    return next;
  }

  private readStored(): Preferences {
    const row = this.database.connection
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(PREFERENCES_SETTINGS_KEY) as {value_json: string} | undefined;
    if (!row) {
      return {favoriteModelIds: []};
    }
    try {
      const parsed = JSON.parse(row.value_json) as {favoriteModelIds?: unknown};
      return {
        favoriteModelIds: Array.isArray(parsed.favoriteModelIds)
          ? dedupe(parsed.favoriteModelIds.filter((id): id is string => typeof id === 'string'))
          : [],
      };
    } catch {
      // A row written by a future schema. Preferences are not worth failing over.
      return {favoriteModelIds: []};
    }
  }
}

/** Order is the user's; the first occurrence of an id wins. */
function dedupe(modelIds: string[]): string[] {
  return [...new Set(modelIds)];
}
