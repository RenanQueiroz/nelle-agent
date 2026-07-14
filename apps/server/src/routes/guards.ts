import {unsupportedSlashCommandMessage} from '../contracts/commands.ts';
import {NELLE_ERROR_CODES} from '../contracts/contracts.ts';
import type {ChatAttachmentInput} from '../lib/types';
import type {LlamaCppManager} from '../llama/manager';
import type {ModelCacheRepository} from '../models/cache';

/**
 * The three guards a chat run is refused by, and the reason they are here rather than in a
 * client: enforcing them only in the composer leaves every *other* client able to post an
 * image to a text-only model, or hand Pi `/model` as a literal prompt.
 *
 * Each throws a coded error, which the stream turns into an `error` event a client renders.
 */

/** llama.cpp is not running, so no run of any kind can start. */
export async function assertRuntimeRunning(llama: LlamaCppManager): Promise<void> {
  if ((await llama.getStatus()).running) {
    return;
  }
  const error = new Error('llama.cpp is not running. Start it in Settings > Runtime.');
  Object.assign(error, {code: NELLE_ERROR_CODES.llamaServerStopped, retryable: true});
  throw error;
}

/**
 * Nelle's chat composer owns a slash-command allowlist. The server owns it too,
 * or `/model` reaches Pi as a literal prompt from any other client.
 */
export function assertSupportedSlashCommand(message: string): void {
  const refusal = unsupportedSlashCommandMessage(message);
  if (!refusal) {
    return;
  }
  const error = new Error(refusal);
  Object.assign(error, {code: NELLE_ERROR_CODES.unsupportedSlashCommand, retryable: false});
  throw error;
}

/**
 * Image attachments need a vision model. `null` means llama.cpp has never
 * reported props, so the model is unproven rather than proven text-only; let it
 * through and let llama.cpp reject it.
 */
/**
 * Refuses an image the answering model has been *proven* unable to see.
 *
 * [modelId] is the **conversation's** model, not the global default: since M2 those are
 * different things, and the run answers on the conversation's. `null` (no model at all)
 * and an unproven model both pass -- the tri-state rule is that only `false` refuses.
 */
export function assertSupportedAttachments(
  attachments: ChatAttachmentInput[],
  modelCache: ModelCacheRepository,
  modelId: string | null,
): void {
  const hasImage = attachments.some(attachment => attachment.kind === 'image');
  if (!hasImage || !modelId) {
    return;
  }
  if (modelCache.getVisionSupport(modelId) !== false) {
    return;
  }
  const error = new Error(
    'The selected model cannot read images. Choose a vision model, or remove the image attachments.',
  );
  Object.assign(error, {code: NELLE_ERROR_CODES.unsupportedAttachment, retryable: false});
  throw error;
}
