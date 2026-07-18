import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  DEFAULT_TITLE_PROMPT,
  DEFAULT_TITLE_SETTINGS,
  TITLE_MAX_CHARACTERS,
  firstLineTitle,
  limitTitleWords,
  readTitleSettings,
  renderTitlePrompt,
  sanitizeGeneratedTitle,
} from '../../../src/contracts/titles.ts';

test('the placeholders are substituted, and the substituted text is not rescanned', () => {
  const rendered = renderTitlePrompt(DEFAULT_TITLE_PROMPT, {
    user: 'Explain local setup',
    assistant: 'Use llama.cpp locally',
    maxWords: 6,
  });
  assert.match(rendered, /^User: Explain local setup$/m);
  assert.match(rendered, /^Assistant: Use llama\.cpp locally$/m);
  assert.match(rendered, /Limit it to 6 words\./);
  assert.doesNotMatch(rendered, /\{\{/);

  // A user who types `{{ASSISTANT}}` gets that text sent, not the reply spliced
  // into their own turn. One pass is what guarantees it.
  const injected = renderTitlePrompt('User: {{USER}}\nAssistant: {{ASSISTANT}}', {
    user: 'what does {{ASSISTANT}} do?',
    assistant: 'the reply',
    maxWords: 6,
  });
  assert.equal(injected, 'User: what does {{ASSISTANT}} do?\nAssistant: the reply');
});

test('an unknown placeholder is left exactly as the user typed it', () => {
  assert.equal(
    renderTitlePrompt('{{SYSTEM}} and {{USER}}', {user: 'u', assistant: 'a', maxWords: 6}),
    '{{SYSTEM}} and u',
  );
});

test('a title is cut to whole words, and to a character backstop', () => {
  assert.equal(
    limitTitleWords('one two three four five six seven', 6),
    'one two three four five six',
  );
  assert.equal(limitTitleWords('one two', 6), 'one two');
  assert.equal(limitTitleWords('', 6), '');

  // One very long "word" -- a URL, a stack frame -- cannot become the row.
  const long = limitTitleWords('x'.repeat(500), 6);
  assert.equal(long.length, TITLE_MAX_CHARACTERS);
});

test('the first line is the first line with something on it', () => {
  assert.equal(firstLineTitle('\n\n  \nExplain local setup\nmore', 6), 'Explain local setup');
  assert.equal(firstLineTitle('   ', 6), null);
  assert.equal(firstLineTitle('', 6), null);
  // Windows line endings are lines too.
  assert.equal(firstLineTitle('\r\nhello there\r\n', 6), 'hello there');
  // Interior whitespace is collapsed, so a tab-indented line is not a title
  // that starts with a tab.
  assert.equal(firstLineTitle('\thello \t there', 6), 'hello there');
});

test('a four-hundred-character first line becomes a six-word title', () => {
  const prose = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod '.repeat(6);
  assert.ok(prose.length > 400);
  assert.equal(firstLineTitle(prose, 6), 'lorem ipsum dolor sit amet consectetur');

  // And a 400-character line with no spaces at all falls to the character cap.
  assert.equal(firstLineTitle('y'.repeat(400), 6)?.length, TITLE_MAX_CHARACTERS);
});

test('what the model returns is stripped of the wrapping it was asked not to add', () => {
  assert.equal(sanitizeGeneratedTitle('"Local Model Setup!"', 6), 'Local Model Setup');
  assert.equal(sanitizeGeneratedTitle('**Local Model Setup**', 6), 'Local Model Setup');
  assert.equal(sanitizeGeneratedTitle('# Local Model Setup\nand more', 6), 'Local Model Setup');
  assert.equal(sanitizeGeneratedTitle('Local   Model\tSetup', 6), 'Local Model Setup');
  assert.equal(sanitizeGeneratedTitle('', 6), null);
  assert.equal(sanitizeGeneratedTitle('   \n  ', 6), null);
  assert.equal(sanitizeGeneratedTitle('"" ', 6), null);
});

test('the word cap applies to the model, which will ignore being asked', () => {
  // This is the whole reason `maxWords` is enforced and not merely requested.
  assert.equal(
    sanitizeGeneratedTitle('Setting Up A Local Language Model Server For Offline Use', 6),
    'Setting Up A Local Language Model',
  );
  assert.equal(sanitizeGeneratedTitle('One Two Three', 20), 'One Two Three');
});

test('a settings row is narrowed, and anything unreadable falls to its default', () => {
  assert.deepEqual(readTitleSettings(undefined), DEFAULT_TITLE_SETTINGS);
  assert.deepEqual(readTitleSettings({mode: 'first-line', prompt: 'p', maxWords: 3}), {
    mode: 'first-line',
    prompt: 'p',
    maxWords: 3,
  });
  assert.deepEqual(readTitleSettings({mode: 'nonsense', maxWords: 0, prompt: 42}), {
    mode: DEFAULT_TITLE_SETTINGS.mode,
    prompt: DEFAULT_TITLE_SETTINGS.prompt,
    maxWords: DEFAULT_TITLE_SETTINGS.maxWords,
  });
  assert.equal(readTitleSettings({maxWords: 2.5}).maxWords, DEFAULT_TITLE_SETTINGS.maxWords);
});
