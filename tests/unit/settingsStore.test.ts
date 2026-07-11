import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {useSettingsStore} from '../../apps/web/src/stores/settingsStore.ts';

test('settings drafts invent nothing before the server answers', () => {
  const initial = useSettingsStore.getState();

  // The store used to seed `{c: '8192'}`, a second copy of a policy the server
  // owns -- and the exact context size that clamps max_tokens to 1. There is now
  // no default context size anywhere: llama.cpp picks the window.
  assert.deepEqual(initial.globalParamRows, []);
  assert.equal(initial.modelsMaxInput, '');
  assert.equal(initial.sleepIdleInput, '');

  const paramValues = initial.globalParamRows.map(row => row.value);
  assert.equal(paramValues.includes('16384'), false);
  assert.equal(paramValues.includes('8192'), false);
});

test('seeding from the server fills the drafts, and an absent value stays absent', () => {
  const store = useSettingsStore.getState();

  store.seedModelDrafts({c: '32768'}, []);
  assert.deepEqual(
    useSettingsStore.getState().globalParamRows.map(row => [row.key, row.value]),
    [['c', '32768']],
  );

  // No global params configured is an empty table, not a guessed default.
  store.resetGlobalParamRows(undefined);
  assert.deepEqual(useSettingsStore.getState().globalParamRows, []);

  store.resetRuntimeDrafts(2, 120);
  assert.equal(useSettingsStore.getState().modelsMaxInput, '2');
  assert.equal(useSettingsStore.getState().sleepIdleInput, '120');
});
