import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, test} from 'bun:test';

import {runCommandStreaming, type CommandOutputLine} from '../../apps/server/src/process.ts';
import type {RuntimeInstallEvent} from '../../packages/shared/src/runtime.ts';
import {createTestServer} from './helpers/testServer.ts';
import {createTempPaths} from './helpers/paths.ts';

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

afterEach(() => {
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
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

test('output arrives line by line, from both streams, and each stream keeps its order', async () => {
  const lines: CommandOutputLine[] = [];
  await runCommandStreaming(await script('echo one\necho two >&2\necho three\necho four >&2'), [], {
    onLine: output => lines.push(output),
  });

  const of = (stream: 'stdout' | 'stderr') =>
    lines.filter(output => output.stream === stream).map(output => output.line);

  // Order *within* a stream is guaranteed. Order *between* them is not, and cannot be: the
  // two pipes are drained concurrently, and even in a real terminal stdout is block-buffered
  // to a pipe while stderr is unbuffered, so faithful interleaving does not exist anywhere.
  // A client must render the build log as two ordered streams, never claim a global order.
  assert.deepEqual(of('stdout'), ['one', 'three']);
  assert.deepEqual(of('stderr'), ['two', 'four']);
});

test('a line split across two chunks is not torn in half', async () => {
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

test('a failure throws with the exit code, and does NOT repeat the output', async () => {
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
});

test('the install streams, and ends with a terminal status event', async () => {
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
});

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

test('a second install is refused while one is running', async () => {
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
