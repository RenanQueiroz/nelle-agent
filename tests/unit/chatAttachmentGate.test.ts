import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {AppDatabase} from '../../apps/server/src/database.ts';
import {ModelCacheRepository} from '../../apps/server/src/modelCache.ts';
import {assertSupportedAttachments} from '../../apps/server/src/server.ts';
import type {ChatAttachmentInput} from '../../packages/shared/src/contracts.ts';
import {createTempPaths} from './helpers/paths.ts';

/**
 * The chat route's second image gate. It runs after `resolveChatAttachments`, and it
 * used to re-check against the *global* active model while `resolveChatAttachments`
 * checked the conversation's -- so the two could disagree, and the global one won.
 *
 * The route itself needs llama.cpp and Pi running, so it is out of reach of a unit
 * test; the gate is not.
 */
async function cache(): Promise<ModelCacheRepository> {
  const database = new AppDatabase(await createTempPaths());
  await database.open();
  return new ModelCacheRepository(database);
}

function setVision(repo: ModelCacheRepository, modelId: string, vision: boolean): void {
  repo.upsertModelProps(modelId, {
    modelId,
    modalities: {vision, audio: false, video: false},
    canReason: null,
    raw: {},
  });
}

const image: ChatAttachmentInput[] = [
  {id: 'a', kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'x'},
];
const text: ChatAttachmentInput[] = [{id: 'b', kind: 'text', name: 'notes.txt', text: 'hi'}];

test('an image is refused only for the model that has been PROVEN unable to see it', async () => {
  const repo = await cache();
  setVision(repo, 'blind', false);
  setVision(repo, 'seeing', true);

  // The conversation's model is what answers, so it is what decides.
  assert.throws(() => assertSupportedAttachments(image, repo, 'blind'), /cannot read images/);
  assert.doesNotThrow(() => assertSupportedAttachments(image, repo, 'seeing'));
});

test('unproven and absent models both pass -- the tri-state only refuses on false', async () => {
  const repo = await cache();

  // llama.cpp has never reported props for this model, so nothing has been proven. The
  // server does not refuse on a guess; llama.cpp can refuse for itself.
  assert.doesNotThrow(() => assertSupportedAttachments(image, repo, 'never-loaded'));
  // No model at all: nothing to ask.
  assert.doesNotThrow(() => assertSupportedAttachments(image, repo, null));
});

test('a text attachment is never gated on vision', async () => {
  const repo = await cache();
  setVision(repo, 'blind', false);

  assert.doesNotThrow(() => assertSupportedAttachments(text, repo, 'blind'));
});
