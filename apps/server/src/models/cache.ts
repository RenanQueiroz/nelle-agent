import type {AppDatabase} from '../db/database';
import type {LlamaModelProps, LlamaRouterModel} from '../lib/types';

export type CachedModel = {
  sectionId: string;
  hfRepo?: string;
  alias?: string;
  routerModelId?: string;
  status?: string;
  modalities?: LlamaModelProps['modalities'];
  /** llama.cpp's `/props` answer: the window a conversation on it actually gets. */
  contextWindow?: number;
  /** `n_ctx_train`: the window the model was trained for. The ceiling, not the run. */
  contextTrain?: number;
  /** The sha256 of the blob llama.cpp last loaded. `undefined` until it has. */
  modelOid?: string;
  /** `null` when llama.cpp has never reported a chat template for this model. */
  canReason: boolean | null;
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
  context_train: number | null;
  model_oid: string | null;
  can_reason: number | null;
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
    // `COALESCE` on `context_train`: the router reports `n_ctx_train` only for a
    // model it has loaded, so a later `unloaded` listing must not erase what an
    // earlier load taught us.
    const statement = db.prepare(
      `INSERT INTO model_cache (
         section_id, hf_repo, alias, router_model_id, status, context_train, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(section_id) DO UPDATE SET
         hf_repo = excluded.hf_repo,
         alias = excluded.alias,
         router_model_id = excluded.router_model_id,
         status = excluded.status,
         context_train = COALESCE(excluded.context_train, model_cache.context_train),
         updated_at = excluded.updated_at`,
    );
    db.run('BEGIN');
    try {
      for (const model of models) {
        statement.run(
          model.sectionId,
          model.hfRepo ?? null,
          model.alias ?? null,
          model.routerModelId ?? null,
          model.status ?? null,
          routerContextTrain(model.raw),
          now,
        );
      }
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }

  /**
   * Records what `/props?model=...` just reported for one model.
   *
   * `modelOid` is the content hash of the blob llama.cpp actually loaded. A
   * `null` must not erase what an earlier load learned, so it coalesces.
   */
  upsertModelProps(sectionId: string, props: LlamaModelProps, modelOid?: string | null): void {
    this.database.connection
      .prepare(
        `INSERT INTO model_cache (
           section_id, modalities_json, context_window, can_reason, model_oid, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(section_id) DO UPDATE SET
           modalities_json = excluded.modalities_json,
           context_window = excluded.context_window,
           can_reason = excluded.can_reason,
           model_oid = COALESCE(excluded.model_oid, model_cache.model_oid),
           updated_at = excluded.updated_at`,
      )
      .run(
        sectionId,
        JSON.stringify(props.modalities),
        props.contextWindow ?? null,
        props.canReason == null ? null : Number(props.canReason),
        modelOid ?? null,
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

  /** `null` until llama.cpp has reported a chat template for the model. */
  getReasoningSupport(sectionId: string): boolean | null {
    return this.getModel(sectionId)?.canReason ?? null;
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
    contextTrain: row.context_train ?? undefined,
    modelOid: row.model_oid ?? undefined,
    canReason: row.can_reason == null ? null : row.can_reason === 1,
    updatedAt: row.updated_at,
  };
}

/**
 * `raw.meta.n_ctx_train`, which `GET /models` carries once the router has loaded
 * the model. Nelle already received it and threw it away.
 */
function routerContextTrain(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const meta = (raw as {meta?: unknown}).meta;
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const value = (meta as {n_ctx_train?: unknown}).n_ctx_train;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
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
