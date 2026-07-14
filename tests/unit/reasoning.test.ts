import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {
  createThinkingEndTagFilter,
  DEFAULT_NEW_CONVERSATION_REASONING_LEVEL,
  DEFAULT_REASONING_BUDGETS,
  MAX_REASONING_BUDGET,
  normalizeReasoningBudgets,
  DEFAULT_REASONING_LEVEL,
  normalizeReasoningLevel,
  piThinkingLevel,
  reasoningBudgetTokens,
  stripLeadingThinkingEndTag,
  UNLIMITED_REASONING_BUDGET,
} from '../../apps/server/src/contracts/reasoning.ts';
import {templateSupportsThinking} from '../../apps/server/src/contracts/reasoning.ts';
import {
  reasoningBudgetsFromSettings,
  SETTINGS_REGISTRY,
} from '../../apps/server/src/contracts/settings.ts';
import {REASONING_SETTINGS_SLUG} from '../../apps/server/src/contracts/settingsKeys.ts';

test('thinking support is read from the chat template, not the model name', () => {
  // Qwen3 and Gemma 4 both gate their thinking channel on this kwarg.
  assert.equal(
    templateSupportsThinking('{%- if enable_thinking is defined and enable_thinking -%}'),
    true,
  );
  assert.equal(templateSupportsThinking('{{ reasoning_effort }}'), true);
  assert.equal(templateSupportsThinking('{{ thinking_budget }}'), true);
  // A template with no kwarg but a paired tag still thinks.
  assert.equal(templateSupportsThinking('prefix <think> body </think> suffix'), true);
  assert.equal(templateSupportsThinking("{{ '<|channel>thought' }}...{{ '<channel|>' }}"), true);
  // A plain instruct template cannot.
  assert.equal(
    templateSupportsThinking('{% for message in messages %}{{ message.content }}'),
    false,
  );
  assert.equal(templateSupportsThinking(''), false);
  assert.equal(templateSupportsThinking(undefined), false);
});

test('new conversations think, and an unrecognised stored level does not', () => {
  assert.equal(DEFAULT_NEW_CONVERSATION_REASONING_LEVEL, 'max');
  assert.equal(DEFAULT_REASONING_LEVEL, 'off');
});

test('reasoning level normalization falls back to off', () => {
  assert.equal(normalizeReasoningLevel('high'), 'high');
  assert.equal(normalizeReasoningLevel('max'), 'max');
  assert.equal(normalizeReasoningLevel('minimal'), 'off');
  assert.equal(normalizeReasoningLevel(undefined), 'off');
  assert.equal(normalizeReasoningLevel(null), 'off');
});

test('only the max level maps onto a Pi thinking level Nelle does not name', () => {
  assert.equal(piThinkingLevel('off'), 'off');
  assert.equal(piThinkingLevel('low'), 'low');
  assert.equal(piThinkingLevel('medium'), 'medium');
  assert.equal(piThinkingLevel('high'), 'high');
  assert.equal(piThinkingLevel('max'), 'xhigh');
});

test('reasoning budgets clamp per level and reject junk', () => {
  assert.deepEqual(normalizeReasoningBudgets({low: 10, medium: 20, high: 30}), {
    low: 10,
    medium: 20,
    high: 30,
  });
  assert.deepEqual(normalizeReasoningBudgets({low: -5, medium: 'abc', high: 1e9}), {
    low: DEFAULT_REASONING_BUDGETS.low,
    medium: DEFAULT_REASONING_BUDGETS.medium,
    high: 65_536,
  });
  assert.deepEqual(normalizeReasoningBudgets(undefined), DEFAULT_REASONING_BUDGETS);
  // llama.cpp's own tiers.
  assert.deepEqual(DEFAULT_REASONING_BUDGETS, {low: 512, medium: 2048, high: 8192});
});

test('off, max, and a zero budget all mean no thinking_budget_tokens', () => {
  const budgets = {low: 512, medium: 2048, high: 8192};
  assert.equal(reasoningBudgetTokens('off', budgets), null);
  // `max` is uncapped by definition, so llama.cpp gets no budget field.
  assert.equal(reasoningBudgetTokens('max', budgets), null);
  assert.equal(reasoningBudgetTokens('low', budgets), 512);
  assert.equal(reasoningBudgetTokens('medium', budgets), 2048);
  assert.equal(reasoningBudgetTokens('high', budgets), 8192);
  // A tier explicitly zeroed in Settings also means "do not cap".
  assert.equal(reasoningBudgetTokens('high', {...budgets, high: UNLIMITED_REASONING_BUDGET}), null);
});

test('a leading thinking end tag is dropped from a completed answer', () => {
  assert.equal(stripLeadingThinkingEndTag('</think>\n\n31 × 47 = 1457'), '31 × 47 = 1457');
  assert.equal(stripLeadingThinkingEndTag('\n</thinking> done'), 'done');
  assert.equal(stripLeadingThinkingEndTag('</reasoning>x'), 'x');
  assert.equal(stripLeadingThinkingEndTag('31 × 47 = 1457'), '31 × 47 = 1457');
  // Only a *leading* tag is noise; one further in is the model's own text.
  assert.equal(stripLeadingThinkingEndTag('see </think> here'), 'see </think> here');
});

test('the streaming filter strips a tag split across deltas', () => {
  const filter = createThinkingEndTagFilter();
  assert.equal(filter.push('</thi'), '');
  assert.equal(filter.push('nk>'), '');
  assert.equal(filter.push('\n\n31 ×'), '31 ×');
  assert.equal(filter.push(' 47'), ' 47');
  assert.equal(filter.flush(), '');
});

test('the streaming filter passes ordinary answers through with one delta of latency', () => {
  const filter = createThinkingEndTagFilter();
  assert.equal(filter.push('Hello'), 'Hello');
  assert.equal(filter.push(' world'), ' world');
});

test('the streaming filter holds an ambiguous prefix and releases it verbatim', () => {
  const filter = createThinkingEndTagFilter();
  assert.equal(filter.push('<'), '');
  assert.equal(filter.push('div>'), '<div>');
});

test('the streaming filter never buffers unboundedly on whitespace', () => {
  const filter = createThinkingEndTagFilter();
  const whitespace = '\n'.repeat(64);
  assert.equal(filter.push(whitespace), whitespace);
});

test('the streaming filter flushes a short held answer', () => {
  const filter = createThinkingEndTagFilter();
  assert.equal(filter.push('</think>'), '');
  assert.equal(filter.flush(), '');

  const other = createThinkingEndTagFilter();
  assert.equal(other.push('</t'), '');
  assert.equal(other.flush(), '</t');
});

test('the budgets are read from the settings group, not from state.json', () => {
  // They lived in `state.json` behind a hand-written route, so every client hand-built
  // three number inputs for them. They are a settings group now: the same three numbers,
  // served in the schema, rendered by whatever renders every other group.
  assert.deepEqual(reasoningBudgetsFromSettings({low: 100, medium: 200, high: 300}), {
    low: 100,
    medium: 200,
    high: 300,
  });

  // Coerced field by field: one unreadable value falls back to its own default and takes
  // no sibling with it -- the rule every settings read follows.
  assert.deepEqual(reasoningBudgetsFromSettings({low: 'nonsense' as never, medium: 200}), {
    low: DEFAULT_REASONING_BUDGETS.low,
    medium: 200,
    high: DEFAULT_REASONING_BUDGETS.high,
  });

  // An empty group is a fresh install, not a broken one.
  assert.deepEqual(reasoningBudgetsFromSettings({}), DEFAULT_REASONING_BUDGETS);

  // `0` is not "unset": it means *no limit*, and it must survive the read.
  assert.equal(reasoningBudgetsFromSettings({low: 0}).low, 0);
});

test('the reasoning group is in the registry, so it renders itself', () => {
  const group = SETTINGS_REGISTRY.find(entry => entry.slug === REASONING_SETTINGS_SLUG);
  assert.ok(group, 'reasoning must be a registry group, not a hand-written route');
  assert.deepEqual(
    group.fields.map(field => field.key),
    ['low', 'medium', 'high'],
    'one number field per budgeted level -- `off` and `max` send no budget, so they have none',
  );
  for (const field of group.fields) {
    assert.equal(field.type, 'number');
    assert.equal(field.integer, true, 'llama.cpp takes whole token counts');
    assert.equal(field.min, 0, '0 means no limit, so it must be reachable');
    assert.equal(field.max, MAX_REASONING_BUDGET);
  }
});
