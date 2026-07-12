import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {displayedUserText} from '../../apps/server/src/piHarness.ts';

const typed = 'What colour is the attached image?';
const enriched = `${typed}\n\nAttached files:\n<attachment name="secret.txt" type="text">\nThe launch code is FALCON-9-BRAVO.\n</attachment>`;

test('a user turn displays what was typed, not what the model was shown', () => {
  // Pi stores the enriched prompt, because that is what it sent. The typed text lives
  // only in the projection, and a metadata-less sync -- every snapshot read -- rebuilds
  // from Pi. Without this, the transcript shows the user the contents of their own
  // attachment pasted into their message.
  assert.equal(displayedUserText('user', enriched, typed), typed);
});

test('a user turn with nothing projected yet takes what Pi has', () => {
  // The first sync of a run, before the run has written `userPromptText`.
  assert.equal(displayedUserText('user', typed, undefined), typed);
});

test("an assistant turn always takes Pi's text", () => {
  // Only user turns are enriched. An assistant's text is Pi's, and a stale projection
  // must never win over it.
  assert.equal(
    displayedUserText('assistant', 'the fresh answer', 'a stale answer'),
    'the fresh answer',
  );
  assert.equal(displayedUserText(null, 'a compaction summary', 'stale'), 'a compaction summary');
});
