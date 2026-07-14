import assert from 'node:assert/strict';
import {test} from 'bun:test';

import type {
  AttachmentMetadata,
  ConversationEntryProjection,
} from '../../apps/server/src/contracts/conversations.ts';
import {buildConversationMessages} from '../../apps/server/src/contracts/messages.ts';

function entry(
  input: Partial<ConversationEntryProjection> & {piEntryId: string},
): ConversationEntryProjection {
  return {
    conversationId: 'c1',
    entryType: 'message',
    createdAt: '2026-07-09T12:00:00.000Z',
    ...input,
  };
}

function attachment(input: {id: string; piEntryId: string}): AttachmentMetadata {
  return {
    id: input.id,
    conversationId: 'c1',
    piEntryId: input.piEntryId,
    kind: 'text',
    name: `${input.id}.txt`,
    createdAt: '2026-07-09T12:00:00.000Z',
  };
}

test('only message entries with a role become messages', () => {
  const messages = buildConversationMessages(
    [
      entry({piEntryId: 'u1', role: 'user', textPreview: 'hello'}),
      entry({piEntryId: 'c1', entryType: 'compaction', textPreview: 'Context compacted.'}),
      entry({piEntryId: 'x1', role: undefined, textPreview: 'no role'}),
      entry({piEntryId: 'a1', role: 'assistant', textPreview: 'hi'}),
    ],
    [],
  );

  assert.deepEqual(
    messages.map(message => [message.id, message.role, message.content]),
    [
      ['u1', 'user', 'hello'],
      ['a1', 'assistant', 'hi'],
    ],
  );
});

test('attachments join onto their Pi entry', () => {
  const messages = buildConversationMessages(
    [entry({piEntryId: 'u1', role: 'user', textPreview: 'read this'})],
    [
      attachment({id: 'att-1', piEntryId: 'u1'}),
      attachment({id: 'att-2', piEntryId: 'u1'}),
      // An unbound attachment belongs to no message yet.
      {...attachment({id: 'att-3', piEntryId: 'u1'}), piEntryId: undefined},
    ],
  );

  assert.deepEqual(
    messages[0]?.attachments?.map(item => item.id),
    ['att-1', 'att-2'],
  );
});

test('a user turn a regenerate replayed is shown once', () => {
  // Regeneration branches before the original user entry and replays its text,
  // so Pi holds the same prompt twice.
  const messages = buildConversationMessages(
    [
      entry({piEntryId: 'u1', role: 'user', textPreview: 'what is 2+2'}),
      entry({piEntryId: 'a1', role: 'assistant', parentPiEntryId: 'u1', textPreview: 'four'}),
      entry({piEntryId: 'u2', role: 'user', textPreview: 'what is 2+2'}),
      entry({
        piEntryId: 'a2',
        role: 'assistant',
        parentPiEntryId: 'u2',
        textPreview: '4',
        regeneratesPiEntryId: 'a1',
        displayGroupId: 'a1',
      }),
    ],
    [],
  );

  assert.deepEqual(
    messages.map(message => message.id),
    ['u1', 'a1', 'a2'],
    'the replayed prompt u2 is hidden, both answers survive',
  );
});

test('a contentless assistant entry is dropped unless it has something to show', () => {
  // Pi persists a failed turn as an assistant entry with no content and retries.
  const ghost = entry({piEntryId: 'ghost', role: 'assistant', textPreview: '   '});

  assert.deepEqual(buildConversationMessages([ghost], []), []);

  // But a turn that spent its whole reasoning budget still has a thinking block.
  const thinking = buildConversationMessages([{...ghost, reasoning: 'let me think'}], []);
  assert.equal(thinking.length, 1);

  // And one that ran a tool has the tool row.
  const tooled = buildConversationMessages(
    [{...ghost, toolCalls: [{id: 't1', name: 'read_file', status: 'complete'}]}],
    [],
  );
  assert.equal(tooled.length, 1);

  // A user turn is never dropped for being empty.
  assert.equal(buildConversationMessages([{...ghost, role: 'user'}], []).length, 1);
});

test('answers to one prompt are labelled as variants of each other', () => {
  const messages = buildConversationMessages(
    [
      entry({piEntryId: 'u1', role: 'user', textPreview: 'ask'}),
      entry({
        piEntryId: 'a1',
        role: 'assistant',
        textPreview: 'first',
        createdAt: '2026-07-09T12:00:02.000Z',
        displayGroupId: 'a1',
      }),
      entry({
        piEntryId: 'a2',
        role: 'assistant',
        textPreview: 'second',
        createdAt: '2026-07-09T12:00:01.000Z',
        displayGroupId: 'a1',
        regeneratesPiEntryId: 'a1',
      }),
    ],
    [],
  );

  const variants = messages.filter(message => message.role === 'assistant');
  // Labelled oldest-first regardless of the order the entries arrived in.
  assert.deepEqual(
    variants.map(message => [message.id, message.variantLabel]),
    [
      ['a1', 'variant 2/2'],
      ['a2', 'variant 1/2'],
    ],
  );
});

test('a single answer carries no variant label', () => {
  const messages = buildConversationMessages(
    [entry({piEntryId: 'a1', role: 'assistant', textPreview: 'only answer'})],
    [],
  );
  assert.equal(messages[0]?.variantLabel, undefined);
});

test('the projection is pure: same input, same output', () => {
  const entries = [
    entry({piEntryId: 'u1', role: 'user', textPreview: 'hello'}),
    entry({piEntryId: 'a1', role: 'assistant', textPreview: 'hi'}),
  ];
  assert.deepEqual(buildConversationMessages(entries, []), buildConversationMessages(entries, []));
});
