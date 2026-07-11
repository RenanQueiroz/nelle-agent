/**
 * Short, fire-and-collect commands (git, cmake, tar, ps, taskkill, `--help`)
 * run through `Bun.spawn`. The long-running, detached llama-server stays on
 * `node:child_process` in `llamacpp.ts` until its full lifecycle (log capture,
 * process-group kill, Windows) can be verified against a real binary.
 */
export async function runCommand(
  command: string,
  args: string[],
  options: {cwd?: string; env?: NodeJS.ProcessEnv} = {},
): Promise<string> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: {...process.env, ...options.env},
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    return stdout.trim();
  }
  throw new Error(`${command} ${args.join(' ')} failed with ${exitCode}: ${stderr.trim()}`);
}

export async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    await runCommand(probe, [command]);
    return true;
  } catch {
    return false;
  }
}
