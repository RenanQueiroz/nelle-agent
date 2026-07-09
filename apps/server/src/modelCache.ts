import type {AppDatabase} from './database';
import type {LlamaModelProps, LlamaRouterModel} from './types';

export type CachedModel = {
  sectionId: string;
  hfRepo?: string;
  alias?: string;
  routerModelId?: string;
  status?: string;
  modalities?: LlamaModelProps['modalities'];
  contextWindow?: number;
  updatedAt: string;
};

type ModelCacheRow = {
  section_id: string;
  hf_repo: string | null;
  alias: string | null;
  router_model_id: string | null;
  status: string | null;
  modalities_json: string | null;
  context_window: number | null;
  updated_at: string;
};

/**
 * Last-known router metadata for each `models.ini` section.
 *
 * This is a cache and never a source of truth: the router is authoritative
 * whenever it is up, and `models.ini` owns the catalog. It exists so the server
 * can answer "can this model see images?" and "how big is its context?" without
 * a live llama.cpp -- for conversation snapshots, for attachment validation, and
 * for clients that cannot reach the router themselves.
 *
 * When llama-server is stopped the rows are left alone rather than cleared;
 * `updated_at` is how staleness is expressed.
 */
export class ModelCacheRepository {
  constructor(private readonly database: AppDatabase) {}

  /** Records what `/models` just reported, preserving any cached props. */
  upsertRouterModels(models: LlamaRouterModel[]): void {
    const db = this.database.connection;
    const now = new Date().toISOString();
    const statement = db.prepare(
      `INSERT INTO model_cache (
         section_id, hf_repo, alias, router_model_id, status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(section_id) DO UPDATE SET
         hf_repo = excluded.hf_repo,
         alias = excluded.alias,
         router_model_id = excluded.router_model_id,
         status = excluded.status,
         updated_at = excluded.updated_at`,
    );
    db.exec('BEGIN');
    try {
      for (const model of models) {
        statement.run(
          model.sectionId,
          model.hfRepo ?? null,
          model.alias ?? null,
          model.routerModelId ?? null,
          model.status ?? null,
          now,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Records what `/props?model=...` just reported for one model. */
  upsertModelProps(sectionId: string, props: LlamaModelProps): void {
    this.database.connection
      .prepare(
        `INSERT INTO model_cache (
           section_id, modalities_json, context_window, updated_at
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(section_id) DO UPDATE SET
           modalities_json = excluded.modalities_json,
           context_window = excluded.context_window,
           updated_at = excluded.updated_at`,
      )
      .run(
        sectionId,
        JSON.stringify(props.modalities),
        props.contextWindow ?? null,
        new Date().toISOString(),
      );
  }

  getModel(sectionId: string): CachedModel | null {
    const row = this.database.connection
      .prepare('SELECT * FROM model_cache WHERE section_id = ?')
      .get(sectionId) as ModelCacheRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * A model the user has never loaded has no props, so vision support is
   * unknown rather than absent. Mirrors the composer's tri-state `canReason`.
   */
  getVisionSupport(sectionId: string): boolean | null {
    return this.getModel(sectionId)?.modalities?.vision ?? null;
  }

  /** Drops rows for sections that no longer exist in `models.ini`. */
  pruneMissingSections(sectionIds: string[]): void {
    const db = this.database.connection;
    if (sectionIds.length === 0) {
      db.prepare('DELETE FROM model_cache').run();
      return;
    }
    const placeholders = sectionIds.map(() => '?').join(', ');
    db.prepare(`DELETE FROM model_cache WHERE section_id NOT IN (${placeholders})`).run(
      ...sectionIds,
    );
  }
}

function mapRow(row: ModelCacheRow): CachedModel {
  return {
    sectionId: row.section_id,
    hfRepo: row.hf_repo ?? undefined,
    alias: row.alias ?? undefined,
    routerModelId: row.router_model_id ?? undefined,
    status: row.status ?? undefined,
    modalities: parseModalities(row.modalities_json),
    contextWindow: row.context_window ?? undefined,
    updatedAt: row.updated_at,
  };
}

function parseModalities(value: string | null): LlamaModelProps['modalities'] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object') {
      const modalities = parsed as Partial<LlamaModelProps['modalities']>;
      return {
        vision: modalities.vision === true,
        audio: modalities.audio === true,
        video: modalities.video === true,
      };
    }
  } catch {
    // A row written by a future schema. Treat it as unknown.
  }
  return undefined;
}
