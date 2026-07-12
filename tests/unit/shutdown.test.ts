import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The server must die when it is told to, even while a client is streaming.
 *
 * `Bun.serve().stop()` is graceful: it waits for in-flight requests to finish.
 * Nelle's in-flight requests include **SSE streams, which never finish on purpose**
 * -- a client holds the router event stream open for its entire life. So a graceful
 * stop waited forever and the process had to be SIGKILLed.
 *
 * That is not a tidy-up detail. Turning on LAN access *requires* a server restart
 * (the listener is built at boot), and the client that wants LAN access is exactly
 * the one holding a stream open. Hence `stop(true)`.
 *
 * The fake llama.cpp is what makes this deterministic: `/api/llama/models/events`
 * proxies llama.cpp's `/models/sse`, so a stand-in that accepts the connection and
 * then says nothing reproduces the real never-ending stream with no real router.
 */
test('SIGTERM stops the server even while an SSE stream is open', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-shutdown-'));
  const port = 18797;
  const llamaPort = 18899;

  // A router that emits its opening event and then holds the stream open forever --
  // which is what llama.cpp's /models/sse does once no model is loading. The first
  // chunk matters: headers are not flushed until a body byte exists, so a stream that
  // says nothing at all never even becomes a response.
  const fakeLlama = Bun.serve({
    hostname: '127.0.0.1',
    port: llamaPort,
    idleTimeout: 255,
    fetch: () =>
      new Response(
        new ReadableStream({
          start: controller => {
            controller.enqueue(new TextEncoder().encode('data: {"event":"hello"}\n\n'));
            // ...and never close.
          },
        }),
        {headers: {'content-type': 'text/event-stream'}},
      ),
  });

  const child = Bun.spawn(['bun', path.resolve('apps/server/src/index.ts')], {
    env: {
      ...process.env,
      NELLE_DATA_DIR: dataDir,
      NELLE_PORT: String(port),
      NELLE_LLAMA_PORT: String(llamaPort),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);

    const stream = await fetch(`http://127.0.0.1:${port}/api/llama/models/events`, {
      headers: {accept: 'text/event-stream'},
    });
    assert.equal(stream.status, 200);

    child.kill('SIGTERM');

    const outcome = await Promise.race([
      child.exited,
      Bun.sleep(8000).then(() => 'timeout' as const),
    ]);
    assert.notEqual(
      outcome,
      'timeout',
      'the server never exited: a graceful stop is waiting on an SSE stream that never ends',
    );

    await stream.body?.cancel().catch(() => {});
  } finally {
    child.kill('SIGKILL');
    fakeLlama.stop(true);
    await fs.rm(dataDir, {recursive: true, force: true});
  }
}, 30_000);

async function waitForHealth(base: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error('the server never became healthy');
}
