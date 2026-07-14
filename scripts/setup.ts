/**
 * `bun run setup` — everything a fresh clone needs that this repository actually owns.
 *
 * **Tier 1 only.** It installs nothing that a package manager owns: not Bun, not the Flutter SDK,
 * not the JDK, not the Android SDK, not Xcode, not a keyring. `doctor` reports those and prints the
 * exact command for this OS; see `scripts/doctor.ts` for why installing them would be wrong (sudo,
 * no single correct install method, non-idempotence, licence prompts, and the chicken-and-egg of a
 * Bun script installing Bun).
 *
 * Idempotent. Safe to re-run. It will **not** re-arm a pre-push hook you deliberately turned off.
 */

import {doctor} from './doctor.ts';
import {armHooksUnlessDeclined} from './hooks.ts';

async function step(label: string, command: string[], cwd?: string): Promise<void> {
  console.log(`\n▸ ${label}`);
  const proc = Bun.spawn(command, {cwd, stdout: 'inherit', stderr: 'inherit'});
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n  failed: ${command.join(' ')}`);
    process.exit(code);
  }
}

console.log('Nelle — setup');

await step('bun install', ['bun', 'install']);

// The Flutter client. If Flutter is missing, `doctor` says so at the end with the right command --
// we do not fail here, because a server-only contributor should still get a working setup.
const hasFlutter = Bun.which('flutter') != null;
if (hasFlutter) {
  await step('flutter pub get (apps/client)', ['flutter', 'pub', 'get'], 'apps/client');
  await step('dart pub global activate marionette_mcp', [
    'dart',
    'pub',
    'global',
    'activate',
    'marionette_mcp',
  ]);
} else {
  console.log(
    '\n▸ Flutter not found — skipping the client setup (doctor will tell you how to fix it)',
  );
}

// The pre-push hook. `.githooks/pre-push` is committed and arrives with the clone; all that is
// missing is `core.hooksPath`, which is local config and cannot be.
console.log('\n▸ pre-push hook');
switch (await armHooksUnlessDeclined()) {
  case 'armed':
    console.log('  armed (bun run hooks off to disable, git push --no-verify for one push)');
    break;
  case 'already':
    console.log('  already armed');
    break;
  case 'declined':
    console.log('  disabled — you turned it off, and setup respects that (bun run hooks on)');
    break;
}

const code = await doctor();
if (code === 0) {
  console.log('Setup complete.\n');
}
process.exit(code);
