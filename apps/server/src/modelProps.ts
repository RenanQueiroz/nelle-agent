import {blobOidForModelPath, GgufMetadataRepository} from './ggufMetadata';
import type {ModelCacheRepository} from './modelCache';
import type {LlamaModelProps} from './types';

/**
 * Everything a successful `/props` teaches Nelle, recorded in one place.
 *
 * `/props` answers only for a model llama.cpp has loaded at least once, which
 * makes it the one moment the file on disk is known -- and the only moment
 * llama.cpp might have swapped it, because it re-resolves `--hf-repo` and
 * re-downloads on every load.
 *
 * The GGUF header is re-read only when the blob's content hash moves. That is
 * the common case answering "nothing to do": a chat-template fix upstream
 * changes the oid, an unchanged model does not.
 */
export async function recordModelProps(input: {
  sectionId: string;
  props: LlamaModelProps;
  modelCache: ModelCacheRepository;
  ggufMetadata?: GgufMetadataRepository;
  /** Errors here must never fail a chat; the caller logs and moves on. */
  onError?: (error: unknown) => void;
}): Promise<void> {
  const modelPath = readModelPath(input.props.raw);
  const oid = modelPath ? await blobOidForModelPath(modelPath) : null;
  input.modelCache.upsertModelProps(input.sectionId, input.props, oid);

  if (!oid || !modelPath || !input.ggufMetadata) {
    return;
  }
  try {
    await input.ggufMetadata.ensureParsed(oid, modelPath);
  } catch (error) {
    // A header Nelle cannot parse is a missing detail, never a failed turn.
    input.onError?.(error);
  }
}

/** `/props` `raw.model_path`: the snapshot symlink llama.cpp opened. */
function readModelPath(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = (raw as {model_path?: unknown}).model_path;
  return typeof value === 'string' && value ? value : null;
}
