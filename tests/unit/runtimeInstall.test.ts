import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'bun:test';

import {runCommandStreaming, type CommandOutputLine} from '../../apps/server/src/process.ts';
import type {RuntimeInstallEvent} from '../../apps/server/src/contracts/runtime.ts';
import {createTestServer} from './helpers/testServer.ts';
import {createTempPaths} from './helpers/paths.ts';
import {needsPosixShell} from './helpers/platform.ts';

/**
 * Installing llama.cpp is a **build**, not a request.
 *
 * On Linux it is a `git clone` plus a full cmake compile -- minutes, sometimes tens of them.
 * The non-streaming route awaits all of it and answers once, which fails three ways at the
 * same time: the user watches a spinner with no idea whether it is working; the build's own
 * output is buffered and then thrown away; and any client with a receive timeout (the
 * Flutter client's is 30 s) reports failure while the build carries happily on server-side.
 */

const originalServerPath = process.env.LLAMA_SERVER_PATH;
const originalPath = process.env.PATH;

const originalLlamaPort = process.env.NELLE_LLAMA_PORT;

/**
 * **A port nothing is listening on**, and it is load-bearing.
 *
 * The runtime status probe calls a llama.cpp healthy on the configured port *running* -- it has
 * to, because llama-server is detached and survives a Nelle restart, which is the whole point of
 * pid-file adoption. So a test left on the default 8080 does not test a stopped runtime: it
 * **adopts the developer's own llama-server** and reports `running: true`. This test was written
 * that way and failed exactly like that, against a real llama-server on 8080.
 */
const DEAD_LLAMA_PORT = '18098';

afterEach(() => {
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
  }
  if (originalLlamaPort === undefined) {
    delete process.env.NELLE_LLAMA_PORT;
  } else {
    process.env.NELLE_LLAMA_PORT = originalLlamaPort;
  }
  process.env.PATH = originalPath;
});

/** Reads an SSE body into the inner events, ignoring the envelope. */
function eventsFrom(body: string): RuntimeInstallEvent[] {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)) as {data: RuntimeInstallEvent})
    .map(envelope => envelope.data);
}

async function script(body: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-cmd-'));
  const file = path.join(directory, 'script.sh');
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, {mode: 0o755});
  return file;
}

test.skipIf(needsPosixShell)(
  'output arrives line by line, from both streams, and each stream keeps its order',
  async () => {
    const lines: CommandOutputLine[] = [];
    await runCommandStreaming(
      await script('echo one\necho two >&2\necho three\necho four >&2'),
      [],
      {
        onLine: output => lines.push(output),
      },
    );

    const of = (stream: 'stdout' | 'stderr') =>
      lines.filter(output => output.stream === stream).map(output => output.line);

    // Order *within* a stream is guaranteed. Order *between* them is not, and cannot be: the
    // two pipes are drained concurrently, and even in a real terminal stdout is block-buffered
    // to a pipe while stderr is unbuffered, so faithful interleaving does not exist anywhere.
    // A client must render the build log as two ordered streams, never claim a global order.
    assert.deepEqual(of('stdout'), ['one', 'three']);
    assert.deepEqual(of('stderr'), ['two', 'four']);
  },
);

test.skipIf(needsPosixShell)('a line split across two chunks is not torn in half', async () => {
  // A chunk boundary is not a line boundary. Emitting each chunk as it lands would cut a
  // compiler diagnostic in two, which is exactly the output that matters most.
  const long = 'x'.repeat(200_000);
  const lines: CommandOutputLine[] = [];
  await runCommandStreaming(await script(`printf '%s\\n' "${long}"`), [], {
    onLine: output => lines.push(output),
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.line.length, 200_000);
});

test.skipIf(needsPosixShell)(
  'a failure throws with the exit code, and does NOT repeat the output',
  async () => {
    // `runCommand` packs the entire stderr into the Error message -- for a failed cmake build
    // that is a megabyte of text inside one JSON error field. Here the output has already been
    // streamed, so repeating it in the error would be the same mistake twice.
    const noisy = await script('echo "compiling..."\necho "error: no such file" >&2\nexit 3');
    const lines: CommandOutputLine[] = [];

    await assert.rejects(
      () => runCommandStreaming(noisy, [], {onLine: output => lines.push(output)}),
      (error: Error) => {
        assert.match(error.message, /exited with 3/);
        assert.doesNotMatch(error.message, /no such file/, 'the output must not be in the error');
        return true;
      },
    );

    // ...but the user saw it, which is the point.
    assert.deepEqual(lines, [
      {stream: 'stdout', line: 'compiling...'},
      {stream: 'stderr', line: 'error: no such file'},
    ]);
  },
);

test.skipIf(needsPosixShell)(
  'the install streams, and ends with a terminal status event',
  async () => {
    // `external` mode: `LLAMA_SERVER_PATH` is the user's own binary, so there is nothing to
    // build and the route reports status. It exercises the whole stream end to end without a
    // ten-minute compile.
    process.env.LLAMA_SERVER_PATH = await script('echo "version: test"');
    const app = await createTestServer(await createTempPaths());

    try {
      const response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      assert.equal(response.statusCode, 200);
      assert.match(response.headers['content-type'] ?? '', /text\/event-stream/);

      const events = eventsFrom(response.body);
      assert.deepEqual(
        events.map(event => event.type),
        ['runtime.install.started', 'runtime.install.completed'],
      );

      const started = events[0];
      assert.equal(started?.type === 'runtime.install.started' && started.mode, 'external');

      const completed = events[1];
      assert.ok(completed?.type === 'runtime.install.completed');
      assert.equal(completed.runtime.installed, true, 'the terminal event carries the status');
    } finally {
      await app.close();
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'a failed install ends in an error event, not a dead stream',
  async () => {
    // A real failure of the real build path: with an empty PATH the dependency check cannot
    // find `git`, so `buildLinuxFromMaster` gives up before cloning anything. (Setting
    // LLAMA_SERVER_PATH would NOT fail -- `external` means the binary is the user's and there
    // is nothing to build, so it reports status and succeeds. That was this test's first,
    // wrong, premise.)
    delete process.env.LLAMA_SERVER_PATH;
    process.env.PATH = '';
    const app = await createTestServer(await createTempPaths());

    try {
      const response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      // The *stream* is a 200 even when the install fails: by the time the build gives up,
      // the response has long since begun. The failure is an event, not a status code.
      assert.equal(response.statusCode, 200);

      const events = eventsFrom(response.body);
      const last = events.at(-1);
      assert.ok(last?.type === 'runtime.install.failed');
      assert.equal(last.error.code, 'runtime_install_failed');
      assert.match(last.error.message, /Missing build dependency/);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(process.platform !== 'linux')(
  'a new binary replaces one that is RUNNING (ETXTBSY)',
  async () => {
    // Found by driving the real app: a build compiled to 100%, then died on the very last
    // step with `ETXTBSY: text file is busy` copying llama-server into place. You cannot
    // overwrite a running executable on Linux -- so *updating* llama.cpp while it was running
    // had always failed, after a full ten-minute build, and nobody could see it: the old route
    // buffered the output and threw it away.
    //
    // Unlinking a running binary IS allowed (the process keeps its inode), so the fix is to
    // remove the directory entry first. This test runs a real executable and overwrites it.
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-etxtbsy-'));
    const target = path.join(directory, 'running-binary');
    // A real ELF binary, not a `#!/bin/sh` script: exec'ing a script makes the *interpreter*
    // the busy text file and merely reads the script, so a script reproduces nothing. Only the
    // executable image the kernel maps is locked -- which llama-server is.
    await fs.copyFile('/bin/sleep', target);
    await fs.chmod(target, 0o755);

    const child = Bun.spawn([target, '30'], {stdout: 'ignore', stderr: 'ignore'});
    // Give the kernel a moment to actually map the image.
    await Bun.sleep(100);
    try {
      // The kernel now refuses a plain overwrite of this file.
      const replacement = path.join(directory, 'new-binary');
      await fs.copyFile('/bin/true', replacement);
      await assert.rejects(
        () => fs.copyFile(replacement, target),
        (error: NodeJS.ErrnoException) => {
          assert.equal(error.code, 'ETXTBSY', 'the bug this test exists for');
          return true;
        },
      );

      // ...and unlink-then-copy, which is what the installer does, succeeds anyway.
      await fs.rm(target, {force: true});
      await fs.copyFile(replacement, target);
      assert.deepEqual(
        await fs.readFile(target),
        await fs.readFile('/bin/true'),
        'the new binary is in place, and the running one carried on with its own inode',
      );
    } finally {
      child.kill();
      await child.exited;
    }
  },
);

test.skipIf(needsPosixShell)('a second install is refused while one is running', async () => {
  // A source build takes minutes and the button shows nothing, so a second click is not an
  // exotic race -- it is the obvious thing to do. Two builds would `rm -rf` each other's
  // `build/` directory.
  const paths = await createTempPaths();
  const {LlamaCppManager} = await import('../../apps/server/src/llamacpp.ts');
  const {AppStore} = await import('../../apps/server/src/store.ts');
  const llama = new LlamaCppManager(paths, new AppStore(paths));

  // A slow "external install", so the second call lands while the first is still in flight.
  process.env.LLAMA_SERVER_PATH = await script('sleep 1\necho ok');
  const first = llama.installOrUpdate();
  await assert.rejects(
    () => llama.installOrUpdate(),
    (error: Error & {code?: string}) => {
      assert.equal(error.code, 'runtime_install_in_progress');
      return true;
    },
  );
  await first;

  // ...and once it finishes, the guard is released rather than latched forever.
  await llama.installOrUpdate();
});

/**
 * **`GET /api/runtime` and `GET /api/runtime/logs`, which nothing on the server tested.**
 *
 * Both routes were covered only by the Playwright suite, through `apps/web` — which has since been
 * deleted. The M9 audit walked all 46 e2e tests to prove the deletion cost no server coverage,
 * and these two are the entire bill: 39 of the 46 mock the API outright, and every other
 * real-server behaviour had a named unit test already. `/api/runtime/logs` had **no test
 * anywhere** in the repository, while the Flutter client calls it on every visit to the
 * llama.cpp screen.
 *
 * So they are tested here, on the server, where they belonged in the first place. A route whose
 * only cover is a browser is a route that stops being covered the moment the browser goes.
 */
test.skipIf(needsPosixShell)(
  'GET /api/runtime reports a fresh install, and the runtime settings group it launches with',
  async () => {
    process.env.NELLE_LLAMA_PORT = DEAD_LLAMA_PORT;
    const paths = await createTempPaths();
    const app = await createTestServer(paths);
    try {
      const response = await app.inject({method: 'GET', url: '/api/runtime'});
      assert.equal(response.statusCode, 200);
      const status = response.json<{
        installed: boolean;
        running: boolean;
        binaryPath: string | null;
        installedVersion: string | null;
        latestVersion: string | null;
        modelsMax: number;
        sleepIdleSeconds: number;
        pid: number | null;
      }>();

      // Nothing is built, and that is a *state*, not an error -- it is what every install looks
      // like before the user has compiled llama.cpp, and the screen has to render it.
      assert.equal(status.installed, false);
      assert.equal(status.running, false);
      assert.equal(status.installedVersion, null);
      assert.equal(status.pid, null);

      // **`binaryPath` is null when there is no binary**, which is what the contract promises and
      // what both clients' `?? 'Not installed'` fallback is written against. The server used to
      // report the path llama-server *would* live at, so that fallback was dead code and a fresh
      // install displayed the path of a file that did not exist. Nothing tested this route, which
      // is how it survived.
      assert.equal(status.binaryPath, null);

      // **`latest` costs a GitHub round trip, so it is only fetched when asked for.** An unasked-for
      // network call on a status poll is how an offline machine gets a slow, failing settings screen.
      assert.equal(status.latestVersion, null);

      // The launch limits are the `runtime` settings group; this route only *reports* them. The
      // registry keeps `modelsMax` at 1 on purpose -- a fresh install on constrained hardware must
      // not try to hold two models -- and a multi-model test has to raise it rather than assume it.
      assert.equal(status.modelsMax, 1);
      assert.equal(status.sleepIdleSeconds, 90);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(needsPosixShell)(
  'GET /api/runtime reports the binary path once a binary is actually there',
  async () => {
    // The other half of the contract, so the fix above cannot be over-applied into "always null".
    // `LLAMA_SERVER_PATH` is the `external` install mode: the binary is the user's own, and Nelle
    // reports where it is rather than pretending it installed it.
    process.env.NELLE_LLAMA_PORT = DEAD_LLAMA_PORT;
    const binary = await script('echo "version: test"');
    process.env.LLAMA_SERVER_PATH = binary;

    const paths = await createTempPaths();
    const app = await createTestServer(paths);
    try {
      const status = (await app.inject({method: 'GET', url: '/api/runtime'})).json<{
        installed: boolean;
        binaryPath: string | null;
        installMode: string;
      }>();
      assert.equal(status.installed, true);
      assert.equal(status.binaryPath, path.resolve(binary));
      assert.equal(status.installMode, 'external');
    } finally {
      await app.close();
    }
  },
);

test.skipIf(needsPosixShell)(
  'GET /api/runtime reflects a PATCH of the runtime settings group',
  async () => {
    process.env.NELLE_LLAMA_PORT = DEAD_LLAMA_PORT;
    const paths = await createTempPaths();
    const app = await createTestServer(paths);
    try {
      const patched = await app.inject({
        method: 'PATCH',
        url: '/api/settings/runtime',
        payload: {modelsMax: 2, sleepIdleSeconds: 30},
      });
      assert.equal(patched.statusCode, 200);

      // The status route is a *view* of the settings group, not a second copy of it. If these ever
      // disagree, a user raises `modelsMax` to run two models, the runtime screen keeps saying 1,
      // and the only way to find out which is true is to load a second model and watch it evict the
      // first -- which reports a pass while testing eviction.
      const status = (await app.inject({method: 'GET', url: '/api/runtime'})).json<{
        modelsMax: number;
        sleepIdleSeconds: number;
      }>();
      assert.equal(status.modelsMax, 2);
      assert.equal(status.sleepIdleSeconds, 30);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(needsPosixShell)(
  'GET /api/runtime/logs answers with an empty tail when llama.cpp has never run',
  async () => {
    process.env.NELLE_LLAMA_PORT = DEAD_LLAMA_PORT;
    const paths = await createTempPaths();
    const app = await createTestServer(paths);
    try {
      const response = await app.inject({method: 'GET', url: '/api/runtime/logs'});
      assert.equal(response.statusCode, 200);
      const tail = response.json<{path: string; text: string}>();

      // **A missing log file is not an error.** llama.cpp has never started, so there is nothing to
      // read -- and the route must say "empty", not 500, or the llama.cpp screen cannot render on
      // exactly the machine that most needs it: one where the runtime has never come up.
      assert.equal(tail.text, '');
      // The path is served even when the file is absent, because it is what the user needs in order
      // to go and look for themselves.
      assert.equal(tail.path, paths.llamaLogPath);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(needsPosixShell)(
  'GET /api/runtime/logs tails the END of the log, and caps what it will read',
  async () => {
    process.env.NELLE_LLAMA_PORT = DEAD_LLAMA_PORT;
    const paths = await createTempPaths();
    await fs.mkdir(path.dirname(paths.llamaLogPath), {recursive: true});
    // A log is append-only and grows without bound; what a reader wants is the *end* of it, which
    // is where the failure that just happened is.
    await fs.writeFile(paths.llamaLogPath, `${'x'.repeat(500)}THE-LAST-LINE\n`, 'utf8');

    const app = await createTestServer(paths);
    try {
      const full = (await app.inject({method: 'GET', url: '/api/runtime/logs'})).json<{
        text: string;
      }>();
      assert.match(full.text, /THE-LAST-LINE/);

      // `maxBytes` reads the tail, not the head.
      const tail = (await app.inject({method: 'GET', url: '/api/runtime/logs?maxBytes=14'})).json<{
        text: string;
      }>();
      assert.equal(tail.text, 'THE-LAST-LINE\n');

      // Garbage falls back to the default rather than reading zero bytes or throwing: a broken query
      // string must not be able to blank the one screen that explains why the runtime will not start.
      const nonsense = (
        await app.inject({method: 'GET', url: '/api/runtime/logs?maxBytes=banana'})
      ).json<{text: string}>();
      assert.match(nonsense.text, /THE-LAST-LINE/);
    } finally {
      await app.close();
    }
  },
);
