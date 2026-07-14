import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {test} from 'bun:test';

import {hostCapabilities, whyImpossible} from '../../../scripts/lib/hostCapabilities.ts';

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

test('the pre-push hook is committed, executable, and travels with a clone', () => {
  // `.git/hooks/` is inside `.git` and is never tracked, so a hook placed there dies with the
  // clone. `.githooks/` is an ordinary repo directory: the script and its **mode** are both
  // tracked, and only `core.hooksPath` (local config) has to be set on a new machine.
  //
  // **Assert git's INDEX mode, not the filesystem's.** Windows has no POSIX permission bits, so
  // `fs.stat().mode & 0o111` is meaningless there — the first version of this test did exactly that
  // and failed on the Windows runner while the hook was perfectly fine. What actually has to be
  // true is that *git* records the file as executable, because that is what a fresh clone on Linux
  // or macOS restores. `git ls-files -s` reports the index mode and is identical on every platform.
  const listed = Bun.spawnSync(['git', 'ls-files', '-s', '.githooks/pre-push']);
  assert.match(
    listed.stdout.toString(),
    /^100755 /,
    'git must track the executable bit, or a fresh clone gets a hook it cannot run',
  );
});

test('the hook scopes itself to what changed, and skips a docs-only push', async () => {
  const hook = (await fs.readFile('.githooks/pre-push', 'utf8')).replace(/\r\n/g, '\n');

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

test('the release workflow is tag-only: a push to main can never publish binaries', async () => {
  // **A safety invariant, not a style preference.** Publishing downloadable binaries under the
  // owner's name on a public repository is a deliberate human act. An automated run -- or an agent
  // working through a plan -- must not be able to do it on its way past. The release workflow
  // therefore triggers on a **tag** and on nothing else.
  // **Normalise line endings.** Git checks out with CRLF on Windows, so a regex written with `\n`
  // matches nothing there — which is how the first version of this test failed on the Windows
  // runner while the workflow was correct. Any test that reads a repository file and matches on
  // line structure has to do this.
  const release = (await fs.readFile('.github/workflows/release.yml', 'utf8')).replace(
    /\r\n/g,
    '\n',
  );

  assert.match(release, /tags:\s*\['v\*'\]/, 'the release must be tag-triggered');
  // The dangerous shape is `push: {branches: [main]}`. If that ever appears here, every commit to
  // main would cut a release.
  const pushBlock = /on:\s*\n\s*push:\s*\n((?:\s{4}.*\n)*)/.exec(release)?.[1] ?? '';
  assert.doesNotMatch(pushBlock, /branches:/, 'the release must NOT trigger on a branch push');

  // Least privilege: only the publishing job may write to the repository.
  assert.match(release, /^permissions:\n {2}contents: read$/m, 'the default must be read-only');
  assert.equal(
    (release.match(/contents: write/g) ?? []).length,
    1,
    'exactly one job may hold contents:write',
  );
});

test('CI runs the binary smoke test on all three operating systems', async () => {
  // The bug that shipped once -- a binary that built successfully and could not read a PDF -- is
  // per-OS by nature (native bindings, path resolution, dlopen). Checking it only on Linux would
  // leave the other two exactly as exposed as before.
  const ci = (await fs.readFile('.github/workflows/ci.yml', 'utf8')).replace(/\r\n/g, '\n');
  const smoke = /binary:\s*\n[\s\S]*?matrix:\s*\n\s*os:\s*\[([^\]]+)\]/.exec(ci)?.[1] ?? '';
  for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
    assert.ok(smoke.includes(os), `the binary smoke test must run on ${os}`);
  }
  assert.match(ci, /bun run build --target=server/, 'and it must go through the build smoke test');
});
