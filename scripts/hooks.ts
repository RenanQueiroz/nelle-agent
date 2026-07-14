/**
 * `bun run hooks on | off | status` — arm or disarm the pre-push gate.
 *
 * **What is committed and what is not**, because this is the part that confuses people:
 *
 * | thing                                  | tracked? | on a fresh clone       |
 * |----------------------------------------|----------|------------------------|
 * | `.githooks/pre-push` (the script)      | **yes**  | already there          |
 * | its executable bit                     | **yes**  | already set            |
 * | `git config core.hooksPath .githooks`  | **no**   | set once, by `setup`   |
 *
 * You never rewrite the hook on a new machine. `.git/hooks/` lives *inside* `.git`, which is never
 * tracked, so a hook placed there dies with the clone. `core.hooksPath` is git's supported way to
 * point at a directory you *do* commit — and git deliberately will not arm it on clone, because that
 * would mean `git clone` executes arbitrary code from a stranger.
 *
 * **Intent is recorded separately from the mechanism** (`nelle.hooks`). Without that, `setup` would
 * silently re-arm a hook you deliberately turned off, and `off` would last only until your next
 * `setup`. Because this is *local* repo config, each clone decides for itself — the laptop can run
 * with hooks off while the desktop runs with them on. That is a feature.
 */

const HOOKS_PATH = '.githooks';

async function git(args: string[]): Promise<{ok: boolean; out: string}> {
  const proc = Bun.spawn(['git', ...args], {stdout: 'pipe', stderr: 'pipe'});
  const out = await new Response(proc.stdout).text();
  return {ok: (await proc.exited) === 0, out: out.trim()};
}

/** Whether the hook is armed right now. */
export async function hooksArmed(): Promise<boolean> {
  const {ok, out} = await git(['config', '--get', 'core.hooksPath']);
  return ok && out === HOOKS_PATH;
}

/**
 * What the user has *chosen*, as opposed to what is currently configured.
 *
 * `null` means they have never chosen — which is what lets `setup` arm the hook on a fresh clone
 * without overriding a deliberate `hooks off`.
 */
export async function hooksIntent(): Promise<boolean | null> {
  const {ok, out} = await git(['config', '--get', 'nelle.hooks']);
  if (!ok || out === '') {
    return null;
  }
  return out === 'true';
}

export async function enableHooks(): Promise<void> {
  await git(['config', 'core.hooksPath', HOOKS_PATH]);
  await git(['config', 'nelle.hooks', 'true']);
}

export async function disableHooks(): Promise<void> {
  await git(['config', '--unset', 'core.hooksPath']);
  await git(['config', 'nelle.hooks', 'false']);
}

/** Arms the hook **unless the user has explicitly turned it off**. Used by `setup`. */
export async function armHooksUnlessDeclined(): Promise<'armed' | 'declined' | 'already'> {
  const intent = await hooksIntent();
  if (intent === false) {
    return 'declined';
  }
  if (await hooksArmed()) {
    return 'already';
  }
  await enableHooks();
  return 'armed';
}

async function status(): Promise<void> {
  const armed = await hooksArmed();
  const intent = await hooksIntent();
  console.log(`pre-push hook: ${armed ? 'ENABLED' : 'disabled'}`);
  if (!armed && intent === false) {
    console.log('  (you turned it off — `bun run hooks on` to re-enable)');
  } else if (!armed) {
    console.log('  (never configured in this clone — `bun run setup` or `bun run hooks on`)');
  }
}

if (import.meta.main) {
  const command = process.argv[2] ?? 'status';
  switch (command) {
    case 'on':
      await enableHooks();
      console.log('pre-push hook: ENABLED');
      break;
    case 'off':
      await disableHooks();
      console.log('pre-push hook: disabled (`git push --no-verify` also skips it for one push)');
      break;
    case 'status':
      await status();
      break;
    default:
      console.error(`unknown command "${command}". Use: on | off | status`);
      process.exit(1);
  }
}
