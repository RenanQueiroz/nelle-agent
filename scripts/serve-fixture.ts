import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {SessionManager} from '@earendil-works/pi-coding-agent';

import {createAppPaths} from '../apps/server/src/lib/paths';
import {createServer} from '../apps/server/src/server';
import {AppDatabase} from '../apps/server/src/db/database';
import {ConversationRepository} from '../apps/server/src/conversations/repository';
import {AppStore} from '../apps/server/src/models/store';

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
 * It builds nothing. Nelle serves no web app -- an unmatched path is a coded JSON 404 -- so the
 * fixture is the API server and nothing else.
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
const llamaPort = Number(process.env.NELLE_LLAMA_PORT);

/**
 * The **slow tier** needs a real llama.cpp and real weights, and it borrows both rather than
 * spending three minutes compiling and 2.6 GB downloading on every run.
 *
 * - `LLAMA_SERVER_PATH` is the documented external-binary override, and points at the developer's
 *   build.
 * - `LLAMA_CACHE` is honoured *over* Nelle's own choice, deliberately (see AGENTS: "an explicit
 *   choice wins"), so llama.cpp finds the gemma-4-E2B blobs already on disk.
 *
 * It still runs llama.cpp on the fixture's **own** port, so it cannot collide with — or be mistaken
 * for — the developer's. Nothing here writes to the developer's data directory: the borrowed cache
 * is read (and, at worst, re-verified) by llama.cpp, never deleted by Nelle, whose own
 * `ownsModelCache()` goes false the moment `LLAMA_CACHE` is set by hand.
 */
const slow = process.env.NELLE_DEVICE_SLOW === '1';
if (slow) {
  const devDataDir = path.join(repoRoot, '.nelle');
  process.env.LLAMA_SERVER_PATH ??= path.join(devDataDir, 'llama', 'bin', 'llama-server');
  process.env.LLAMA_CACHE ??= path.join(devDataDir, 'models');
}

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
  /**
   * Bound to a Pi session file that is not there -- `unavailable` from the moment it is read.
   *
   * Seeded broken rather than broken by the test, because the test runs **on the device** (an
   * emulator, even) and cannot reach into the host's filesystem to move a file. The fixture can,
   * and it is the fixture's job to produce the states the app has to survive.
   */
  broken: 'A conversation whose history is gone',
  /**
   * The needle for the search test, and it is deliberately **not on the first page**: the list
   * route pages at 50, so this one is created first (making it the oldest, and therefore last) and
   * padded past the boundary. A client-side filter over the loaded rows would never find it --
   * which is the entire reason search is a server query.
   */
  needle: 'Xylophone concerto in B minor',
  /** How many filler rows sit between the needle and the first page. */
  fillerCount: 60,
  /**
   * A configured model — **without which the composer never even tries to send**.
   *
   * The client blocks a send with no model selected, so the message would never reach the server
   * and the `llama_server_stopped` refusal would never happen. The point of the fixture is to
   * produce the state under test, and "llama.cpp is stopped but a model is configured" is a state
   * every fresh install is in: the model is a line in `models.ini`, and llama.cpp has to be built
   * before it can run. Nothing is downloaded and nothing is loaded.
   */
  modelId: 'unsloth/gemma-4-E2B-it-qat-GGUF:Q4_K_XL',
} as const;

async function seed(): Promise<void> {
  // A model in `models.ini`, and llama.cpp not installed: exactly what a fresh install looks like
  // after its first import. Without it the composer refuses client-side and the server's own
  // refusal is never exercised.
  const store = new AppStore(paths);
  await store.addHuggingFaceModel({
    repoId: 'unsloth/gemma-4-E2B-it-qat-GGUF',
    quant: 'UD-Q4_K_XL',
  });

  const database = new AppDatabase(paths);
  await database.open();
  try {
    const conversations = new ConversationRepository(database);
    await conversations.init();

    // Oldest first: `updated_at` descending is the sidebar's order, so this ends up last -- past
    // the 50-row page boundary, which is the whole point of it.
    conversations.createConversation({title: FIXTURE.needle});
    for (let i = 0; i < FIXTURE.fillerCount; i += 1) {
      conversations.createConversation({title: `Filler conversation ${i + 1}`});
    }

    // **These sessions can be read, but not continued.** Writing Pi entries by hand produces a
    // session Pi's agent will happily *replay* and then complete with no text at all -- so a chat
    // sent to one of these conversations gets `pi_run_failed` and no answer. Only a session Pi
    // itself created (i.e. `POST /api/conversations`) can be chatted with.
    //
    // That is fine, and deliberate: these exist for the **fast tier**, which never sends a message.
    // The slow tier makes its own conversations through the API.
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

    // Bound to a session file that does not exist. `markUnavailableIfPiSessionInvalid` will find
    // it the moment anything reads the conversation.
    const broken = conversations.createConversation({title: FIXTURE.broken});
    const brokenPath = path.join(paths.piSessionsDir, 'this-file-was-never-written.jsonl');
    conversations.attachPiSession(broken.id, {
      piSessionPath: brokenPath,
      piSessionId: 'a-session-that-is-gone',
      activeLeafPiEntryId: 'e-broken-assistant',
    });
    // Give a rebuild something to work from -- a rebuild reconstructs the Pi session from the
    // projection, so an empty projection would rebuild into an empty conversation and prove
    // nothing.
    //
    // The field is **`text`**, not `textPreview`: despite the column being named `text_preview` it
    // holds the full message, and `SyncConversationEntry` calls it `text`. Writing the wrong key
    // silently stored empty strings, and the rebuild then "worked" and produced blank messages.
    //
    // And `activeLeafPiEntryId` must be set, because a rebuild walks the **active path**
    // (`getActivePathEntries`) -- with no leaf there is no path, and it rebuilds into nothing.
    conversations.replaceConversationProjection(broken.id, {
      piSessionPath: brokenPath,
      piSessionId: 'a-session-that-is-gone',
      activeLeafPiEntryId: 'e-broken-assistant',
      entries: [
        {
          piEntryId: 'e-broken-user',
          entryType: 'message',
          role: 'user',
          text: 'A question whose answer is now only in SQLite.',
          createdAt: new Date().toISOString(),
        },
        {
          piEntryId: 'e-broken-assistant',
          parentPiEntryId: 'e-broken-user',
          entryType: 'message',
          role: 'assistant',
          text: 'And this is that answer.',
          createdAt: new Date().toISOString(),
        },
      ],
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

/**
 * The **empty** conversation is created through the API, not the repository.
 *
 * `SessionManager.create()` allocates a session path; it does **not** write the file. Only
 * `POST /api/conversations` does (it calls `ensureSessionFile`, which is private to the harness) --
 * so a repository-seeded "empty" conversation was not empty at all, it was *broken*, and answered
 * `session_unavailable` instead of `conversation_not_branchable`. Two different refusals.
 *
 * Going through the route makes it byte-for-byte what a user's empty conversation is, which is the
 * only thing that makes a test about empty conversations mean anything. (Chasing the wrong refusal
 * also turned up a real server bug: branching an *unavailable* conversation answered a bare 500.)
 */
const created = await fetch(`http://127.0.0.1:${server.port}/api/conversations`, {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({title: FIXTURE.empty}),
});
if (!created.ok) {
  throw new Error(`fixture could not create the empty conversation: ${created.status}`);
}

if (slow) {
  // A previous run that was killed rather than stopped leaves its detached llama-server behind. It
  // is holding a preset from a data directory that no longer exists, so adopting it is worse than
  // useless -- reap it before starting a clean one.
  const orphan = await fetch(`http://127.0.0.1:${llamaPort}/health`)
    .then(response => response.ok)
    .catch(() => false);
  if (orphan) {
    console.log(`reaping an orphaned llama-server on ${llamaPort}`);
    await fetch(`http://127.0.0.1:${port}/api/runtime/stop`, {method: 'POST'}).catch(() => {});
  }

  // Start llama.cpp so the tests do not each pay for it. The model is *not* loaded here: loading is
  // the server's job on the first run, and watching it happen is one of the things being tested.
  const started = await fetch(`http://127.0.0.1:${server.port}/api/runtime/start`, {
    method: 'POST',
  });
  const status = (await started.json()) as {running?: boolean; lastError?: string | null};
  if (!status.running) {
    throw new Error(`fixture could not start llama.cpp: ${status.lastError ?? 'unknown'}`);
  }
  console.log('llama.cpp running (slow tier)');
}

console.log(`fixture server on http://127.0.0.1:${server.port} (data: ${dataDir})`);

const shutdown = async (): Promise<void> => {
  // **Stop llama.cpp, or it outlives us and the next run adopts it.**
  //
  // Nelle's managed llama-server is *detached on purpose* -- it survives a Nelle restart so a new
  // process can adopt it by pid file. That is right for a real install and wrong for a fixture:
  // this data directory is wiped on every run, so the orphan keeps running against a preset that no
  // longer exists, and the runtime probe -- which treats **any** healthy server on the port as a
  // running llama.cpp -- hands it straight to the next fixture. The symptom is a slow tier that
  // "works" while talking to a llama-server configured by a run that finished an hour ago.
  if (slow) {
    await fetch(`http://127.0.0.1:${port}/api/runtime/stop`, {method: 'POST'}).catch(() => {});
  }
  // `stop(true)` closes sockets rather than waiting for in-flight requests -- an SSE stream never
  // finishes, so a graceful stop would hang forever with the app connected and the next run would
  // never get the port back.
  await server.stop(true);
  await app.close();
};

process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
