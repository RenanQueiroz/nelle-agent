import assert from 'node:assert/strict';
import test from 'node:test';

import {buildConversationRows} from '../../apps/web/src/utils/conversationRows.ts';

function conversation(id: string, pinned = false) {
  return {
    id,
    title: `Chat ${id}`,
    titleSource: 'fallback' as const,
    pinned,
    status: 'ready' as const,
    updatedAt: '2026-07-09T12:00:00.000Z',
  };
}

test('rows flatten into pinned and recent sections with stable keys', () => {
  const rows = buildConversationRows(
    [conversation('a', true), conversation('b'), conversation('c')],
    '',
    3,
  );

  assert.deepEqual(
    rows.map(row => row.key),
    ['section:pinned', 'conversation:a', 'section:recent', 'conversation:b', 'conversation:c'],
  );
  // Stable keys are what keep virtualized rows from reusing DOM state across
  // search, pinning and deletion.
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
});

test('a search relabels the recent section as results', () => {
  const rows = buildConversationRows([conversation('a')], 'needle', 1);
  const section = rows[0];
  assert.equal(section?.type === 'section' && section.id, 'results');
  assert.equal(section?.type === 'section' && section.label, 'Results');
});

test('the recent count is the server total, not the loaded window', () => {
  // One pinned row plus two loaded unpinned rows, out of 512 matches.
  const rows = buildConversationRows(
    [conversation('a', true), conversation('b'), conversation('c')],
    '',
    512,
  );
  const pinnedSection = rows.find(row => row.type === 'section' && row.id === 'pinned');
  const recentSection = rows.find(row => row.type === 'section' && row.id === 'recent');

  assert.equal(pinnedSection?.type === 'section' && pinnedSection.count, 1);
  assert.equal(recentSection?.type === 'section' && recentSection.count, 511);
});

test('an empty section is omitted rather than rendered with a zero count', () => {
  assert.deepEqual(buildConversationRows([], '', 0), []);

  const onlyPinned = buildConversationRows([conversation('a', true)], '', 1);
  assert.equal(
    onlyPinned.some(row => row.type === 'section' && row.id === 'recent'),
    false,
  );
});
