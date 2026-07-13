import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {SessionManager} from '@earendil-works/pi-coding-agent';

import {createAppPaths} from '../apps/server/src/paths';
import {createServer} from '../apps/server/src/server';
import {AppDatabase} from '../apps/server/src/database';
import {ConversationRepository} from '../apps/server/src/conversations';

/**
 * The Nelle server the **device tests** drive.
 *
 * A real server, on a throwaway `NELLE_DATA_DIR`, seeded with a known conversation set. Not a
 * mock: the whole point of `integration_test` is that it exercises the real thing, and a suite
 * that stubs the backend is a suite that agrees with itself.
 *
 * Three things it must get right, and one of them has already bitten this repository:
 *
 * 1. **`NELLE_LLAMA_PORT` is pinned away from 8080.** The runtime probe treats *any* healthy
 *    server on the configured port as a running llama.cpp — so on the default the suite would
 *    adopt a developer's real llama-server, and a test whose subject is a *stopped* runtime would
 *    pass while testing nothing. (That is exactly how an M7 test came to pass alone and fail in
 *    the suite.)
 * 2. **The data directory is thrown away**, so a device test can never touch the developer's
 *    conversations, models, or 45 GB of weights.
 * 3. **The listener is trusted**, like loopback in production. The device reaches it over
 *    loopback (`adb reverse` on Android), so requiring a paired device token would test the
 *    harness rather than the app — and pairing is already covered by `devices.test.ts` and three
 *    client test files.
 *
 * It deliberately does **not** build `apps/web` (which `serve-e2e.ts` does, and which M9 T6
 * deletes).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dataDir = path.join(repoRoot, '.nelle-device');

const port = Number(process.env.NELLE_PORT ?? 8797);

await fs.rm(dataDir, {recursive: true, force: true});

process.env.NELLE_DATA_DIR = dataDir;
process.env.NELLE_HOST = '127.0.0.1';
process.env.NELLE_PORT = String(port);
// Never 8080. See (1) above.
process.env.NELLE_LLAMA_PORT = process.env.NELLE_LLAMA_PORT ?? '18081';

const paths = createAppPaths();

/**
 * The conversation set every device test starts from.
 *
 * Seeded through the repository rather than the UI: driving the UI to create fixtures couples the
 * harness to the very thing under test, and a broken sidebar would then look like a broken
 * fixture. Real Pi sessions with real entries, because a conversation with no entries cannot be
 * forked, cloned, or exported — and those are three of the flows being tested.
 */
export const FIXTURE = {
  /** A conversation with a user turn and an answer: forkable, clonable, exportable. */
  withHistory: 'A conversation with history',
  /** A second one, so the sidebar has more than one row and search has something to exclude. */
  aboutPelicans: 'Everything about pelicans',
  /** No entries at all. Cloning it is refused (`conversation_not_branchable`). */
  empty: 'An empty conversation',
} as const;

async function seed(): Promise<void> {
  const database = new AppDatabase(paths);
  await database.open();
  try {
    const conversations = new ConversationRepository(database);
    await conversations.init();

    for (const title of [FIXTURE.withHistory, FIXTURE.aboutPelicans]) {
      const conversation = conversations.createConversation({title});
      const manager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
      manager.appendMessage({role: 'user', content: `Tell me about ${title}.`} as never);
      const leaf = manager.appendMessage({
        role: 'assistant',
        content: `Here is what I know about ${title}.`,
      } as never);
      conversations.attachPiSession(conversation.id, {
        piSessionPath: manager.getSessionFile()!,
        piSessionId: manager.getSessionId(),
        activeLeafPiEntryId: leaf,
      });
    }

    // Bound to a header-only session, exactly as `POST /api/conversations` leaves one. There is
    // nothing to branch from, which is the state the clone refusal is about.
    const empty = conversations.createConversation({title: FIXTURE.empty});
    const emptyManager = SessionManager.create(paths.repoRoot, paths.piSessionsDir);
    conversations.attachPiSession(empty.id, {
      piSessionPath: emptyManager.getSessionFile()!,
      piSessionId: emptyManager.getSessionId(),
    });
  } finally {
    database.close();
  }
}

await seed();

const app = await createServer(paths);

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  // An SSE run can go quiet while a model loads; 255s is Bun's ceiling.
  idleTimeout: 255,
  fetch: req => app.handle(req, {trusted: true}),
});

console.log(`fixture server on http://127.0.0.1:${server.port} (data: ${dataDir})`);

const shutdown = async (): Promise<void> => {
  // `stop(true)` closes sockets rather than waiting for in-flight requests -- an SSE stream never
  // finishes, so a graceful stop would hang forever with the app connected and the next run would
  // never get the port back.
  await server.stop(true);
  await app.close();
};

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
