import assert from 'node:assert/strict';
import {test} from 'bun:test';

// `ConversationEntryProjection` belongs to the shared contract; `conversations.ts` imports it but
// does not re-export it. This test used to take it from there anyway — which typechecked nowhere,
// because `tests/` was outside `tsconfig.include` and Bun erases types at runtime. Import it from
// the module that actually declares it.
import type {ConversationEntryProjection} from '../../apps/server/src/contracts/conversations.ts';
import type {SyncConversationEntry} from '../../apps/server/src/conversations.ts';
import {prependExistingVariantGroup} from '../../apps/server/src/piHarness.ts';

function projectionEntry(
  input: Partial<ConversationEntryProjection> & {piEntryId: string; role: 'user' | 'assistant'},
): ConversationEntryProjection {
  // Defaults first, `...input` last so a caller can override any of them. `piEntryId` and `role`
  // are NOT listed: the signature makes them required, so the spread always supplies them, and
  // assigning them here as well was dead code that `tsc` flagged the moment it could see this file.
  return {
    conversationId: 'c',
    parentPiEntryId: input.parentPiEntryId ?? null,
    entryType: 'message',
    textPreview: input.textPreview ?? '',
    createdAt: input.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...input,
  } as ConversationEntryProjection;
}

test('regenerating an answer preserves the reasoning of the answer it branched from', () => {
  // The old answer lives only in the projection now: it is off the active branch, so
  // `getBranch()` will never return it again. Rebuilding the row without its reasoning
  // writes that loss straight back over the only copy there is.
  const existing = new Map<string, ConversationEntryProjection>([
    ['u1', projectionEntry({piEntryId: 'u1', role: 'user', textPreview: 'What is 17 x 23?'})],
    [
      'a1',
      projectionEntry({
        piEntryId: 'a1',
        parentPiEntryId: 'u1',
        role: 'assistant',
        textPreview: '391',
        reasoning: '17 * 20 = 340, 17 * 3 = 51, so 391.',
        modelAliasSnapshot: 'gemma-4-E4B',
        displayGroupId: 'a1',
      }),
    ],
  ]);

  // What the regenerate produced: the replayed prompt and the new answer.
  const entries: SyncConversationEntry[] = [
    {
      piEntryId: 'u2',
      parentPiEntryId: null,
      entryType: 'message',
      role: 'user',
      text: 'What is 17 x 23?',
      createdAt: '2026-01-01T00:01:00.000Z',
    },
    {
      piEntryId: 'a2',
      parentPiEntryId: 'u2',
      entryType: 'message',
      role: 'assistant',
      text: '391',
      createdAt: '2026-01-01T00:01:01.000Z',
      reasoning: 'Twenty-three seventeens is 391.',
      regeneratesPiEntryId: 'a1',
      displayGroupId: 'a1',
    },
  ];

  prependExistingVariantGroup(entries, existing, 'a1', 'a1');

  const preserved = entries.find(entry => entry.piEntryId === 'a1');
  assert.ok(preserved, 'the answer the regenerate branched from was dropped entirely');
  assert.equal(preserved.reasoning, '17 * 20 = 340, 17 * 3 = 51, so 391.');
  // The rest of the variant is carried across too, so the row still says what answered.
  assert.equal(preserved.modelAliasSnapshot, 'gemma-4-E4B');
  assert.equal(preserved.text, '391');

  // And the new answer keeps its own reasoning.
  assert.equal(
    entries.find(entry => entry.piEntryId === 'a2')?.reasoning,
    'Twenty-three seventeens is 391.',
  );
});
