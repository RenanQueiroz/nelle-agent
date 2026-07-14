import fs from 'node:fs/promises';

/**
 * Windows-portability helpers for the unit suite.
 *
 * The suite never ran on Windows until CI put it there, and it surfaced two classes of failure —
 * **both in the harness, neither in Nelle**. (The compiled-binary smoke test passes on Windows: it
 * builds, runs, and reads a PDF. The product is fine.)
 */

/** True on the Windows runner. */
export const isWindows = process.platform === 'win32';

/**
 * **POSIX shell fixtures do not run on Windows.**
 *
 * Several tests stand a `#!/bin/sh` script in for a real binary — a fake `llama-server` that prints
 * a `--help` catalogue, a fake build command that writes to both streams and exits 3. Windows has
 * no shebang support and no `sh`, so spawning them fails with `ENOENT: uv_spawn`.
 *
 * They are skipped there rather than translated to `.cmd`, and that costs almost nothing: what they
 * actually verify — line splitting across chunk boundaries, stream ordering, exit-code reporting,
 * `--help` parsing — is platform-independent logic, fully covered by the same tests on Linux and
 * macOS. On Windows the product spawns a real `llama-server.exe`; it is only the *stand-in* that is
 * POSIX.
 *
 * Use it as `test.skipIf(needsPosixShell)(...)`, so the reason travels with the skip.
 */
export const needsPosixShell = isWindows;

/**
 * Removes a temp directory, tolerating Windows' file locking.
 *
 * **`fs.rm` throws `EBUSY` on Windows** when anything still holds a handle — and SQLite does not
 * always release immediately after `close()`, where POSIX would let the unlink through regardless.
 * Several tests were failing in *teardown* with their assertions already passed, which is the worst
 * kind of red: it looks like a product bug and is not one.
 *
 * A temp directory that cannot be deleted is **not a test failure**. Retry briefly, then let the OS
 * clean it up.
 */
export async function removeTemp(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(directory, {recursive: true, force: true});
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBUSY' || attempt === 4) {
        // Not a lock, or we have tried enough. The directory is in the OS temp tree; leaving it is
        // strictly better than failing a test that already passed.
        return;
      }
      await Bun.sleep(50 * (attempt + 1));
    }
  }
}

/**
 * A multiplier for deadline-sensitive tests.
 *
 * Some tests pin *deadline logic* — "a load that never finishes times out", "a slow load is not
 * mistaken for a dead child" — using very tight windows (a 5ms timeout, 1ms polling). That is fine
 * against fast localhost HTTP, and it is exactly what Linux and macOS give.
 *
 * Windows' loopback stack is slower and its CI runners are slower still, so a 5ms deadline can
 * elapse before the *first* poll completes — and the test then fails with the wrong error, having
 * proved nothing about the deadline it meant to test. Scaling the window preserves the semantics
 * (the deadline is still enforced, and still far below any real load) while letting the request
 * actually happen.
 *
 * **This is not a tolerance for flakiness.** The assertion is unchanged; only the clock is.
 */
export const slowFactor = isWindows ? 40 : 1;
