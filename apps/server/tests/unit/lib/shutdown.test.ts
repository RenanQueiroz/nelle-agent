import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {removeTemp} from '../helpers/platform.ts';
import {isWindows} from '../helpers/platform.ts';

// **POSIX signals only.** These tests send `SIGTERM` and assert the *graceful* shutdown path --
// draining SSE streams, closing listeners, exiting inside `SHUTDOWN_DEADLINE_MS`. Windows has no
// SIGTERM: `child.kill('SIGTERM')` terminates the process outright, so there is no graceful path to
// observe and nothing here is testable. The behaviour under test is real and worth pinning; it is
// simply a POSIX behaviour.

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
test.skipIf(isWindows)(
  'SIGTERM stops the server even while an SSE stream is open',
  async () => {
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
      await removeTemp(dataDir);
    }
  },
  30_000,
);

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

/**
 * **The server takes llama.cpp down with it.**
 *
 * llama-server is spawned detached so it *can* be adopted across a restart, and for a long time
 * it simply outlived every shutdown. What that leaves behind is a router nobody owns, holding the
 * port and the VRAM, visible only in `ps`.
 *
 * The stand-in is a real process that answers the two questions `isManagedProcess` asks: its
 * command line carries the recorded binary's basename (`llama-server`) and the preset path. That
 * is the whole of what makes a process "ours", so a sleep named correctly is indistinguishable
 * from the real router here — and it needs no 2.6 GB of weights to prove the point.
 */
test.skipIf(isWindows)(
  'SIGTERM takes the managed llama-server down too',
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-llama-stop-'));
    const port = 18798;
    const llamaDir = path.join(dataDir, 'llama');
    const binPath = path.join(llamaDir, 'bin', 'llama-server');
    const presetPath = path.join(llamaDir, 'models.ini');
    await fs.mkdir(path.join(llamaDir, 'bin'), {recursive: true});
    // A "llama-server" that does nothing but stay alive, named and argv'd so the manager
    // recognises it as the process it owns.
    await Bun.write(binPath, '#!/bin/sh\nsleep 300\n');
    await fs.chmod(binPath, 0o755);
    await Bun.write(presetPath, '');

    const fake = Bun.spawn([binPath, '--models-preset', presetPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await Bun.write(
      path.join(llamaDir, 'llama-server.pid.json'),
      JSON.stringify({
        pid: fake.pid,
        binaryPath: binPath,
        args: ['--models-preset', presetPath],
        host: '127.0.0.1',
        port: 18899,
        presetPath,
        startedAt: new Date().toISOString(),
      }),
    );

    const child = Bun.spawn(['bun', path.resolve('apps/server/src/index.ts')], {
      env: {
        ...process.env,
        NELLE_DATA_DIR: dataDir,
        NELLE_PORT: String(port),
        NELLE_LLAMA_PORT: '18899',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    try {
      await waitForHealth(`http://127.0.0.1:${port}`);
      assert.equal(isAlive(fake.pid), true, 'the stand-in must be running before the shutdown');

      child.kill('SIGTERM');
      await Promise.race([child.exited, Bun.sleep(8000)]);

      // The signal is what matters and it is sent first thing; give the child a moment to act on it.
      for (let attempt = 0; attempt < 50 && isAlive(fake.pid); attempt += 1) {
        await Bun.sleep(100);
      }
      assert.equal(
        isAlive(fake.pid),
        false,
        'the llama-server outlived the server that owned it: nobody will ever stop it now',
      );
    } finally {
      child.kill('SIGKILL');
      try {
        process.kill(fake.pid, 'SIGKILL');
      } catch {
        // Already gone, which is the passing case.
      }
      await removeTemp(dataDir);
    }
  },
  30_000,
);

/**
 * The escape hatch, pinned: `NELLE_KEEP_LLAMA=1` restores the old adoption behaviour.
 *
 * `bun --watch` restarts the server on every save, and reloading multi-GB weights each time
 * costs minutes — so a session that is editing server code all day can ask for the stray
 * process instead, and the next start adopts it through the pid file.
 */
test.skipIf(isWindows)(
  'NELLE_KEEP_LLAMA leaves the llama-server running',
  async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-llama-keep-'));
    const port = 18799;
    const llamaDir = path.join(dataDir, 'llama');
    const binPath = path.join(llamaDir, 'bin', 'llama-server');
    const presetPath = path.join(llamaDir, 'models.ini');
    await fs.mkdir(path.join(llamaDir, 'bin'), {recursive: true});
    await Bun.write(binPath, '#!/bin/sh\nsleep 300\n');
    await fs.chmod(binPath, 0o755);
    await Bun.write(presetPath, '');

    const fake = Bun.spawn([binPath, '--models-preset', presetPath], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await Bun.write(
      path.join(llamaDir, 'llama-server.pid.json'),
      JSON.stringify({
        pid: fake.pid,
        binaryPath: binPath,
        args: ['--models-preset', presetPath],
        host: '127.0.0.1',
        port: 18901,
        presetPath,
        startedAt: new Date().toISOString(),
      }),
    );

    const child = Bun.spawn(['bun', path.resolve('apps/server/src/index.ts')], {
      env: {
        ...process.env,
        NELLE_DATA_DIR: dataDir,
        NELLE_PORT: String(port),
        NELLE_LLAMA_PORT: '18901',
        NELLE_KEEP_LLAMA: '1',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    try {
      await waitForHealth(`http://127.0.0.1:${port}`);
      child.kill('SIGTERM');
      await Promise.race([child.exited, Bun.sleep(8000)]);
      // Long enough that a teardown would have landed: the assertion is that none came.
      await Bun.sleep(1500);
      assert.equal(
        isAlive(fake.pid),
        true,
        'NELLE_KEEP_LLAMA asked for the router to be left alone',
      );
    } finally {
      child.kill('SIGKILL');
      try {
        process.kill(fake.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      await removeTemp(dataDir);
    }
  },
  30_000,
);

/** Whether a pid is still running, without caring who owns it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
