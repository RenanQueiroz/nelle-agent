import assert from 'node:assert/strict';
import {test} from 'bun:test';

import {ConversationRepository} from '../../../apps/server/src/conversations/repository.ts';
import {AppDatabase} from '../../../apps/server/src/db/database.ts';
import {restoreActiveLeaf} from '../../../apps/server/src/pi/session.ts';
import {createTempPaths} from '../helpers/paths.ts';

async function makeRepository(): Promise<{
  database: AppDatabase;
  repository: ConversationRepository;
}> {
  const paths = await createTempPaths();
  const database = new AppDatabase(paths);
  await database.open();
  return {database, repository: new ConversationRepository(database)};
}

/** A stand-in for Pi's `SessionManager` that records the branch calls. */
function fakeManager(naturalLeaf: string | null, options: {throwOnBranch?: boolean} = {}) {
  const branched: string[] = [];
  return {
    branched,
    getLeafId: () => naturalLeaf,
    branch: (id: string) => {
      if (options.throwOnBranch) {
        throw new Error(`Entry ${id} not found`);
      }
      branched.push(id);
    },
  };
}

// This is the durability guarantee behind the variant switcher: `SessionManager.branch()` is not
// persisted (the leaf is rebuilt from the file's last physical line on open), so the DB record is
// what a switch survives on. These pin that the record is reapplied — the "survives a restart" test.

test("restoreActiveLeaf reapplies the stored leaf over the file's natural one", async () => {
  const {database, repository} = await makeRepository();
  try {
    const conversation = repository.createConversation({title: 'variants'});
    // The user switched to an older variant; the file's last line is the newest (a3).
    repository.setActiveLeaf(conversation.id, 'a1');
    const manager = fakeManager('a3');

    restoreActiveLeaf(manager, repository, conversation.id);

    assert.deepEqual(manager.branched, ['a1'], 'the DB choice must win over the newest line');
  } finally {
    database.close();
  }
});

test('restoreActiveLeaf is a no-op when the leaf is unset or already current', async () => {
  const {database, repository} = await makeRepository();
  try {
    const conversation = repository.createConversation({title: 'x'});

    // A fresh conversation has no stored leaf — nothing to reapply.
    const unset = fakeManager('a3');
    restoreActiveLeaf(unset, repository, conversation.id);
    assert.deepEqual(unset.branched, []);

    // Already on the stored leaf — no needless branch.
    repository.setActiveLeaf(conversation.id, 'a3');
    const current = fakeManager('a3');
    restoreActiveLeaf(current, repository, conversation.id);
    assert.deepEqual(current.branched, []);
  } finally {
    database.close();
  }
});

test('restoreActiveLeaf swallows a stored leaf missing from the session', async () => {
  const {database, repository} = await makeRepository();
  try {
    const conversation = repository.createConversation({title: 'x'});
    repository.setActiveLeaf(conversation.id, 'gone');
    // A rebuilt file (or a stale row): branch throws. Restore must keep the natural leaf, not crash.
    const manager = fakeManager('a3', {throwOnBranch: true});
    assert.doesNotThrow(() => restoreActiveLeaf(manager, repository, conversation.id));
  } finally {
    database.close();
  }
});
