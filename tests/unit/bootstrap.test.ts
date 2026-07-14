import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'bun:test';

import {hostCapabilities, whyImpossible} from '../../scripts/lib/hostCapabilities.ts';

/**
 * The bootstrap surface: `setup`, `doctor`, `hooks`, and the pre-push gate.
 *
 * `hostCapabilities` is the one that most deserves a test, because **two things depend on it and
 * they must not drift**: `doctor` reports what this host can do, and `build` (step 10) refuses what
 * it cannot. If they each worked it out separately, `build` would eventually offer a target
 * `doctor` calls impossible — which is worse than either being wrong on its own.
 */

test('the host can always build the server, and never a foreign desktop target', () => {
  const host = hostCapabilities();

  // Bun runs everywhere and cross-compiles, so the server is never impossible.
  assert.ok(host.buildTargets.includes('server'));
  // Android and web need no particular host OS.
  assert.ok(host.buildTargets.includes('apk'));
  assert.ok(host.buildTargets.includes('web'));

  // Flutter cannot cross-compile a desktop target. Exactly one desktop target is possible, and it
  // is this host's own.
  const desktop = (['linux', 'macos', 'windows'] as const).filter(target =>
    host.buildTargets.includes(target),
  );
  assert.deepEqual(desktop, [host.os], 'only the host OS desktop target is buildable');

  // iOS needs Xcode, so it follows macOS and nothing else.
  assert.equal(host.buildTargets.includes('ipa'), host.os === 'macos');
});

test('an impossible target explains itself, rather than failing in a build tool', () => {
  const host = hostCapabilities();

  // A possible target has no complaint.
  assert.equal(whyImpossible('server', host), null);

  // The whole point of the module: `build --target=macos` on Linux must say *why*, up front,
  // instead of letting the user discover it from a CMake stack trace three minutes in.
  const foreign = (['linux', 'macos', 'windows', 'ipa'] as const).find(
    target => !host.buildTargets.includes(target),
  );
  assert.ok(foreign, 'no host can build every target; one must be impossible');
  const reason = whyImpossible(foreign, host);
  assert.ok(reason && reason.length > 0);
  assert.match(reason, /require|cannot/i, 'the reason must be a sentence, not a boolean');
});

test('a phone on the LAN cannot reach a WSL2 host, and the capability says so', () => {
  const host = hostCapabilities();
  // Not a misconfiguration to fix: WSL2 is NAT'd, so Nelle binds the VM's 172.31.x.x while the
  // phone sits on the host's 192.168.x.x. The emulator is unaffected -- it runs *inside* WSL and
  // shares the network namespace, which is why the device suite uses it.
  assert.equal(host.lanReachableByPhone, !host.isWsl);
});

test('the pre-push hook is committed, executable, and travels with a clone', async () => {
  // `.git/hooks/` is inside `.git` and is never tracked, so a hook placed there dies with the
  // clone. `.githooks/` is an ordinary repo directory: the script and its **mode** are both
  // tracked, and only `core.hooksPath` (local config) has to be set on a new machine.
  const stat = await fs.stat('.githooks/pre-push');
  assert.ok(stat.mode & 0o111, 'the hook must be executable, or git will not run it');

  const listed = Bun.spawnSync(['git', 'ls-files', '-s', '.githooks/pre-push']);
  assert.match(
    listed.stdout.toString(),
    /^100755 /,
    'git must track the executable bit, or a fresh clone gets a hook it cannot run',
  );
});

test('the hook scopes itself to what changed, and skips a docs-only push', async () => {
  const hook = await fs.readFile('.githooks/pre-push', 'utf8');

  // The scoping is the reason the hook survives contact with a human. The full gate is ~54s, and
  // at ~10 pushes a day an unscoped hook is nine minutes of daily waiting -- which is exactly how
  // `--no-verify` becomes muscle memory, and then the hook protects nothing at all.
  assert.match(hook, /plans\/\|\.\*\\\.md\$/, 'a docs-only push must skip the gate entirely');
  assert.match(hook, /bun run test/, 'a server change runs the server gate');
  assert.match(hook, /flutter analyze && flutter test/, 'a client change runs the client gate');

  // Builds are triggered by *build config*, not by every push: a pure Dart/TS edit essentially
  // cannot break a build that `flutter analyze` and `tsc` would not already catch. What does break
  // builds is dependencies and platform config -- which is what bit us with cargokit/Gradle 9,
  // where `flutter build apk` died while `flutter analyze` stayed clean.
  assert.match(hook, /pubspec\\\.\(yaml\|lock\)/, 'a pubspec change triggers the build');
  assert.match(hook, /android\|ios\|linux\|macos\|windows/, 'a platform-config change does too');

  // It must fail loudly rather than silently skipping a half of the gate it cannot run.
  assert.match(hook, /Refusing to push untested Dart/);
});
