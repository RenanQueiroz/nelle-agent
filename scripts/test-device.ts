/**
 * Runs the Flutter device suite against a real Nelle server.
 *
 * The orchestration has to live on the *host*, not in the test: an `integration_test` runs on the
 * device (a Linux window, or an Android emulator), and a test running inside an emulator cannot
 * start a Bun server on the machine outside it. So this starts the fixture, wires the device to
 * it, runs the suite, and tears everything down.
 *
 *   bun run test:device                 # Linux desktop, fast tier
 *   bun run test:device -- -d emulator-5554
 *
 * **Android needs `adb reverse`**, and that is the whole trick. The emulator's `127.0.0.1` is the
 * emulator, not the host — so a phone normally has to pair over the TLS LAN listener to reach
 * Nelle at all (see the `driving-the-client` skill: WSL2 is NAT'd, the emulator shares its
 * namespace). `adb reverse
 * tcp:<port> tcp:<port>` maps the device's own loopback back to the host's port, which means the
 * Android tests use the *same* loopback path as the desktop ones: no TLS, no pin, no device token,
 * no Keystore.
 */

// This file has no imports, so TypeScript would classify it as a *script* rather than a module —
// and top-level `await` is illegal in a script (TS1375). It uses top-level `await` throughout
// (Bun runs it happily), so declare it a module. Bun does not care; `tsc` does.
export {};

const port = Number(process.env.NELLE_FIXTURE_PORT ?? 8797);
const args = process.argv.slice(2);

const deviceFlag = args.indexOf('-d');
const device = deviceFlag >= 0 ? args[deviceFlag + 1] : 'linux';
const isAndroid = device.startsWith('emulator-') || device.startsWith('android');

// `deviceFlag + 1` is the device NAME, which is not a target. When there is no `-d` at all,
// `deviceFlag` is -1 and that expression is 0 -- which would silently drop the first positional
// argument, i.e. the very file the caller asked to run.
const deviceNameIndex = deviceFlag >= 0 ? deviceFlag + 1 : -1;

// Flags that take a *value*, so the token after them is theirs and is not a target. Without this,
// `--plain-name compact` loses its argument: "compact" does not start with a dash, so it is read
// as the file to run, and flutter is handed a `--plain-name` with nothing after it.
const valueFlags = new Set(['--plain-name', '--name', '--tags', '--exclude-tags']);
const valueIndexes = new Set(
  args.map((arg, i) => (valueFlags.has(arg) ? i + 1 : -1)).filter(i => i >= 0),
);

const isTarget = (arg: string, i: number) =>
  !arg.startsWith('-') && i !== deviceNameIndex && !valueIndexes.has(i);
const targets = args.filter(isTarget);
// The **entrypoint**, not the directory: `flutter test <dir>` runs each file in its own app
// launch, and on Linux the second launch fails outright. See `integration_test/app_test.dart`.
const target =
  targets[0] ??
  (args.includes('--slow') ? 'integration_test/slow_test.dart' : 'integration_test/app_test.dart');

/**
 * Anything else is handed to `flutter test` untouched -- `--plain-name`, above all.
 *
 * The suite is one entrypoint, so without this the only way to re-run a single failing test is to
 * run every test before it. On the slow tier that is minutes of real generation per attempt, which
 * is enough friction to make you debug by staring instead of by running.
 */
const passthrough = args.filter(
  (arg, i) =>
    !isTarget(arg, i) &&
    arg !== '--slow' &&
    arg !== '-d' &&
    i !== deviceNameIndex &&
    arg !== target,
);

const cleanups: Array<() => void | Promise<void>> = [];

async function cleanup(): Promise<void> {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // Teardown is best-effort: a failure here must not mask the test result.
    }
  }
}

// --- the fixture server -------------------------------------------------------------------

// The **slow tier** loads a real model and generates real tokens. It borrows the developer's
// llama.cpp build and their gemma-4-E2B weights (see `serve-fixture.ts`), because compiling and
// re-downloading them per run would cost minutes and gigabytes -- and it is Nelle under test here,
// not llama.cpp's installer, which M7 covered.
const slow = args.includes('--slow');

const fixture = Bun.spawn(['bun', 'run', 'scripts/serve-fixture.ts'], {
  env: {
    ...process.env,
    NELLE_PORT: String(port),
    NELLE_DEVICE_SLOW: slow ? '1' : '0',
  },
  stdout: 'inherit',
  stderr: 'inherit',
});
cleanups.push(() => {
  fixture.kill();
});

const deadline = Date.now() + (slow ? 180_000 : 60_000);
let up = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (response.ok) {
      up = true;
      break;
    }
  } catch {
    // Not listening yet.
  }
  await Bun.sleep(250);
}
if (!up) {
  await cleanup();
  console.error(`fixture server never came up on ${port}`);
  process.exit(1);
}

// --- the device ---------------------------------------------------------------------------

if (isAndroid) {
  // Without this the emulator's `127.0.0.1:<port>` is the emulator, and every request fails.
  const reverse = Bun.spawnSync(['adb', '-s', device, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  if (reverse.exitCode !== 0) {
    await cleanup();
    console.error(`adb reverse failed: ${reverse.stderr.toString()}`);
    process.exit(1);
  }
  cleanups.push(() => {
    Bun.spawnSync(['adb', '-s', device, 'reverse', '--remove', `tcp:${port}`]);
  });
  console.log(`adb reverse tcp:${port} -> host ${port}`);
}

// --- the suite ----------------------------------------------------------------------------

const flutter = Bun.spawn(
  [
    'flutter',
    'test',
    target,
    '-d',
    device,
    // The port is passed in, never guessed. A hard-coded 8787 would point the suite at whatever
    // the developer happens to have running.
    `--dart-define=NELLE_FIXTURE_PORT=${port}`,
    ...passthrough,
  ],
  {cwd: 'apps/client', stdout: 'inherit', stderr: 'inherit'},
);

const exitCode = await flutter.exited;
await cleanup();
process.exit(exitCode);
