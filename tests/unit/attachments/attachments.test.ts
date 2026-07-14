import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {ATTACHMENT_LIMITS} from '../../../apps/server/src/contracts/attachments.ts';
import {chatRequestSchema} from '../../../apps/server/src/contracts/contracts.ts';

/**
 * **The attachment contract, which is all that is left here.**
 *
 * This file used to test `apps/web`'s composer: the fetch-mocking scaffolding below it existed to
 * prove the browser refused an oversized file before spending a round trip on it. The browser is
 * gone, and every one of those rules is enforced by the *server* -- `uploadRoutes.test.ts` and
 * `attachmentIngest.test.ts` are 46 tests between them -- and re-tested by the Flutter client
 * against a real server in the device suite. What belongs here is the shared contract itself.
 */

test('the chat schema takes upload references, and still caps the file count', () => {
  // The composer used to allow 20 files while chatRequestSchema capped the array
  // at 10, so the eleventh came back as an HTTP 500 carrying a zod dump.
  const reference = (index: number) => ({uploadId: `upload-${index}`});

  const atLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles}, (_, i) => reference(i)),
  });
  assert.equal(atLimit.success, true, 'the composer maximum must be acceptable to the server');

  const overLimit = chatRequestSchema.safeParse({
    message: 'read these',
    attachments: Array.from({length: ATTACHMENT_LIMITS.maxFiles + 1}, (_, i) => reference(i)),
  });
  assert.equal(overLimit.success, false);
  assert.match(
    overLimit.error?.issues[0]?.message ?? '',
    /Attach at most 20 files per message/,
    'and one file past it must say so in words',
  );

  // The bytes never travel with the message any more, and neither does a
  // rendering mode: the server decides that from the document. A client sending
  // either is talking to an older server, and must be told so.
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{uploadId: 'u1', kind: 'text', name: 'a.txt', text: 'hello'}],
    }).success,
    false,
  );
  assert.equal(
    chatRequestSchema.safeParse({
      message: 'x',
      attachments: [{uploadId: 'u1', renderPdfAsImages: true}],
    }).success,
    false,
  );
  assert.equal(chatRequestSchema.safeParse({message: 'x', attachments: [{}]}).success, false);
});
