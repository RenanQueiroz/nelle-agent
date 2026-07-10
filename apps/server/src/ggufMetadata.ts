import fs from 'node:fs/promises';
import path from 'node:path';

import type {AppDatabase} from './database';

/**
 * What Nelle keeps from a GGUF header, and how it knows the header is still the
 * one it read.
 *
 * llama.cpp hands the child `--hf-repo repo:QUANT`, not a file path, so it
 * re-resolves the repo and re-downloads on *every* load. A chat-template fix
 * lands upstream and reaches Nelle without Nelle being told. The commit sha is
 * the wrong cache key -- this repository's Hugging Face cache holds two snapshots
 * of `unsloth/gemma-4-26B-A4B-it-qat-GGUF` whose GGUF symlinks point at the same
 * blob -- and a content hash cannot be stale.
 *
 * The blob's *name* is its sha256, the same value the API reports as `lfs.oid`,
 * and Nelle gets it for nothing: `/props` returns `raw.model_path`, which is the
 * snapshot symlink. `realpath` it and take the basename. No network, and no
 * hashing of fourteen gigabytes.
 */
export type GgufMetadata = {
  /** The blob's sha256, and this row's identity. */
  oid: string;
  architecture?: string;
  /** `<arch>.context_length`: the window the model was trained for. */
  contextTrain?: number;
  parameterCount?: number;
};

const BLOB_OID = /^[0-9a-f]{64}$/;

/**
 * The content hash of the file llama.cpp actually loaded, or `null`.
 *
 * `null` when the path is not inside a content-addressed cache -- a `-m` load of
 * a file the user placed themselves. There is nothing to key on then, so nothing
 * is cached.
 */
export async function blobOidForModelPath(modelPath: string): Promise<string | null> {
  try {
    const real = await fs.realpath(modelPath);
    const name = path.basename(real);
    return BLOB_OID.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * Parses the GGUF header of a local file. Around 1.5 seconds for a 14 GB model,
 * because only the header is read.
 *
 * `@huggingface/gguf` is imported lazily and is server-only: it pulls
 * `@huggingface/tasks`, and `tests/unit/webBundle.test.ts` fails if the web
 * bundle ever learns its name.
 */
export async function parseLocalGguf(filePath: string, oid: string): Promise<GgufMetadata> {
  const {gguf} = await import('@huggingface/gguf');
  // `computeParametersCount` sums the tensor descriptors, which are in the header
  // that is being read anyway: measured at 1,439 ms against a 14.2 GB file,
  // against 1,467 ms without it. gemma-4-26B does not declare
  // `general.parameter_count`, so this is the only way to know it offline.
  const parsed = await gguf(filePath, {allowLocalFile: true, computeParametersCount: true});
  // The typed view is a union over every architecture it knows, and Nelle reads
  // keys by name -- including `<arch>.context_length`, whose prefix is only known
  // at runtime. A record view is the honest shape for that.
  const metadata = parsed.metadata as unknown as Record<string, unknown>;
  const architecture = stringValue(metadata['general.architecture']);
  return {
    oid,
    architecture,
    // The key is namespaced by the architecture it belongs to: `gemma4.context_length`.
    contextTrain: positiveInteger(
      architecture ? metadata[`${architecture}.context_length`] : undefined,
    ),
    parameterCount:
      positiveInteger((parsed as {parameterCount?: unknown}).parameterCount) ??
      positiveInteger(metadata['general.parameter_count']),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isInteger(numeric) && numeric > 0
    ? numeric
    : undefined;
}

/**
 * GGUF facts, keyed by content hash.
 *
 * A row is written once per blob and read forever. Nothing here needs the
 * network: once a model is downloaded, everything Nelle shows about it comes
 * from this table and from `/props`. That is why offline is a property of the
 * design rather than a mode.
 */
export class GgufMetadataRepository {
  constructor(private readonly database: AppDatabase) {}

  get(oid: string): GgufMetadata | null {
    const row = this.database.connection
      .prepare('SELECT * FROM gguf_metadata WHERE oid = ?')
      .get(oid) as
      | {
          oid: string;
          architecture: string | null;
          context_train: number | null;
          parameter_count: number | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      oid: row.oid,
      architecture: row.architecture ?? undefined,
      contextTrain: row.context_train ?? undefined,
      parameterCount: row.parameter_count ?? undefined,
    };
  }

  upsert(metadata: GgufMetadata): void {
    this.database.connection
      .prepare(
        `INSERT INTO gguf_metadata (oid, architecture, context_train, parameter_count, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(oid) DO UPDATE SET
           architecture = excluded.architecture,
           context_train = excluded.context_train,
           parameter_count = excluded.parameter_count,
           updated_at = excluded.updated_at`,
      )
      .run(
        metadata.oid,
        metadata.architecture ?? null,
        metadata.contextTrain ?? null,
        metadata.parameterCount ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Reads the header only when this blob has never been seen.
   *
   * Called after every successful load, which is the only moment llama.cpp might
   * have swapped the file. An unchanged oid parses nothing, which is the common
   * case; a changed one means the model was updated upstream.
   */
  async ensureParsed(oid: string, filePath: string): Promise<GgufMetadata> {
    const cached = this.get(oid);
    if (cached) {
      return cached;
    }
    const parsed = await parseLocalGguf(filePath, oid);
    this.upsert(parsed);
    return parsed;
  }
}
