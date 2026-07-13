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
 * Nelle at all (see AGENTS: WSL2 is NAT'd, the emulator shares its namespace). `adb reverse
 * tcp:<port> tcp:<port>` maps the device's own loopback back to the host's port, which means the
 * Android tests use the *same* loopback path as the desktop ones: no TLS, no pin, no device token,
 * no Keystore.
 */

const port = Number(process.env.NELLE_FIXTURE_PORT ?? 8797);
const args = process.argv.slice(2);

const deviceFlag = args.indexOf('-d');
const device = deviceFlag >= 0 ? args[deviceFlag + 1] : 'linux';
const isAndroid = device.startsWith('emulator-') || device.startsWith('android');

// `deviceFlag + 1` is the device NAME, which is not a target. When there is no `-d` at all,
// `deviceFlag` is -1 and that expression is 0 -- which would silently drop the first positional
// argument, i.e. the very file the caller asked to run.
const deviceNameIndex = deviceFlag >= 0 ? deviceFlag + 1 : -1;
const targets = args.filter((arg, i) => !arg.startsWith('-') && i !== deviceNameIndex);
// The **entrypoint**, not the directory: `flutter test <dir>` runs each file in its own app
// launch, and on Linux the second launch fails outright. See `integration_test/app_test.dart`.
const target = targets[0] ?? 'integration_test/app_test.dart';

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

const fixture = Bun.spawn(['bun', 'run', 'scripts/serve-fixture.ts'], {
  env: {...process.env, NELLE_PORT: String(port)},
  stdout: 'inherit',
  stderr: 'inherit',
});
cleanups.push(() => {
  fixture.kill();
});

const deadline = Date.now() + 60_000;
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
  ],
  {cwd: 'apps/client', stdout: 'inherit', stderr: 'inherit'},
);

const exitCode = await flutter.exited;
await cleanup();
process.exit(exitCode);
