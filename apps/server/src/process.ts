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

export type CommandOutputLine = {stream: 'stdout' | 'stderr'; line: string};

/**
 * The same spawn, but the output is handed over **as it happens** instead of at the end.
 *
 * `runCommand` buffers everything and shows the caller none of it: on success it returns
 * stdout to code that discards it, and on failure it throws with the entire stderr packed
 * into one `Error` message. For a llama.cpp source build -- a `git clone` and a full cmake
 * build, ten-plus minutes -- that means the user watches a spinner for ten minutes and then
 * either gets nothing or gets a megabyte of cmake stderr inside a JSON error field.
 *
 * So this streams, line by line, and **throws with only the exit code**: the output has
 * already been delivered, and repeating it in the error would be the same mistake twice.
 */
export async function runCommandStreaming(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    onLine?: (output: CommandOutputLine) => void;
  } = {},
): Promise<void> {
  const proc = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: {...process.env, ...options.env},
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pump = async (
    readable: ReadableStream<Uint8Array>,
    stream: 'stdout' | 'stderr',
  ): Promise<void> => {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of readable) {
      buffered += decoder.decode(chunk, {stream: true});
      // A chunk boundary is not a line boundary, so hold the tail back until its newline
      // arrives. Splitting on the chunk would tear a compiler diagnostic in half.
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        options.onLine?.({stream, line});
      }
    }
    if (buffered) {
      options.onLine?.({stream, line: buffered});
    }
  };

  // Both pipes must be drained concurrently: a process that fills the stderr pipe while
  // nobody is reading it blocks forever, and cmake is chatty on both.
  await Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${exitCode}`);
  }
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
