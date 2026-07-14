import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, test} from 'bun:test';

import {LlamaCppManager} from '../../apps/server/src/llamacpp.ts';
import {AppStore} from '../../apps/server/src/store.ts';
import {createTempPaths} from './helpers/paths.ts';
import {needsPosixShell} from './helpers/platform.ts';

/**
 * **A runtime that will not start must say why.**
 *
 * One mistyped key in `models.ini` -- which a user *can* hand-edit, and which the API's own
 * validator would have refused -- kills llama-server on boot. It exits 1 and writes the reason,
 * naming the key *and* the section it is in. Nelle used to answer `llama-server exited with code
 * 1`: true, and worth nothing. It was holding the sentence the whole time.
 */

/**
 * A port nothing answers on, and that is the entire point.
 *
 * `waitForHealth` polls `host:port` and cannot tell a llama-server it started from any other
 * one. The default is **8080**, which is where a developer's real llama.cpp is -- so these
 * tests, whose whole subject is a llama-server that *died*, would watch the fake binary exit,
 * poll 8080, find the developer's live router, and call the doomed start a success. They passed
 * alone and failed in the suite, which is exactly how the e2e harness came to pin `18080`.
 */
const DEAD_PORT = '18099';

const originalPort = process.env.NELLE_LLAMA_PORT;
const originalServerPath = process.env.LLAMA_SERVER_PATH;

beforeEach(() => {
  process.env.NELLE_LLAMA_PORT = DEAD_PORT;
});

afterEach(() => {
  if (originalPort === undefined) {
    delete process.env.NELLE_LLAMA_PORT;
  } else {
    process.env.NELLE_LLAMA_PORT = originalPort;
  }
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
  }
});

/** A fake llama-server that dies the way a refused preset makes the real one die. */
async function failingServer(directory: string, stderr: string): Promise<string> {
  const scriptPath = path.join(directory, 'llama-server-fails');
  await fs.writeFile(scriptPath, `#!/bin/sh\n>&2 printf '%s\\n' "${stderr}"\nexit 1\n`);
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function manager(binaryPath: string): Promise<LlamaCppManager> {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const state = await store.getState();
  assert.equal(
    String(state.runtime.port),
    DEAD_PORT,
    'the manager must not be pointed at a port a real llama-server could be on',
  );
  process.env.LLAMA_SERVER_PATH = binaryPath;
  return new LlamaCppManager(paths, store);
}

test.skipIf(needsPosixShell)(
  'a failed start reports llama.cpp own reason, not just the exit code',
  async () => {
    const directory = (await createTempPaths()).dataDir;
    await fs.mkdir(directory, {recursive: true});
    const binaryPath = await failingServer(
      directory,
      // The real line, verbatim, from a hand-edited models.ini with one bogus key.
      '0.00.120.274 E srv  llama_server: failed to initialize router models: ' +
        "option 'not-a-real-key' not recognized in preset 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL'",
    );
    const llama = await manager(binaryPath);

    await assert.rejects(() => llama.start());

    const status = await llama.getStatus();
    assert.equal(status.running, false);
    // The exit code is kept -- it is how a reader knows the E line is the *reason* and not one of
    // the E lines a healthy offline load writes on every startup.
    assert.match(status.lastError ?? '', /exited with code 1/);
    // ...and the sentence names both the key and the section, which is the whole point.
    assert.match(status.lastError ?? '', /not-a-real-key/);
    assert.match(status.lastError ?? '', /gemma-4-E4B-it-qat-GGUF/);
    // The timestamp/level prefix is llama.cpp's log format, not part of the message.
    assert.doesNotMatch(status.lastError ?? '', /0\.00\.120/);
  },
);

test.skipIf(needsPosixShell)(
  'a start gives up as soon as the child dies, rather than polling a dead port',
  async () => {
    const directory = (await createTempPaths()).dataDir;
    await fs.mkdir(directory, {recursive: true});
    const binaryPath = await failingServer(directory, '0.00.1 E srv  boom');
    const llama = await manager(binaryPath);

    const startedAt = Date.now();
    await assert.rejects(() => llama.start());
    const elapsed = Date.now() - startedAt;

    // `waitForHealth`'s deadline is 30s. Polling it out would make a doomed start take half a
    // minute to admit it, with the reason already sitting in `#lastError` the entire time.
    assert.ok(
      elapsed < 10_000,
      `a doomed start took ${elapsed}ms; it should fail as the child exits`,
    );
  },
);
