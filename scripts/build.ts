/**
 * `bun run build [--target=<t>] [--all]` — build Nelle for a target.
 *
 * **A dev build command, not an installer.** Packaging is still not implemented; this just makes
 * building the two halves one command with one output directory.
 *
 * The valid targets are computed from `hostCapabilities`, so **an impossible target fails
 * immediately with the reason** — `--target=macos` on Linux says *"macOS builds require a Mac —
 * Flutter cannot cross-compile desktop targets"* rather than letting the user discover it from a
 * CMake stack trace three minutes in. That is the single most valuable thing this script does.
 *
 * **Every server binary it produces is smoke-tested**: built, *run*, and handed a real PDF. A
 * successful build is not a working artifact — `bun build --compile` once reported success on a
 * binary that could not read a single PDF, because pdfjs resolves files relative to
 * `import.meta.url` and that path lives inside Bun's virtual filesystem. A build that cannot read a
 * PDF must never reach a release page. See `tests/unit/compiledBinary.test.ts`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {hostCapabilities, whyImpossible, type BuildTarget} from './lib/hostCapabilities.ts';

const host = hostCapabilities();
const args = process.argv.slice(2);

const requested = args.find(arg => arg.startsWith('--target='))?.slice('--target='.length);
const buildAll = args.includes('--all');

function usage(message?: string): never {
  if (message) {
    console.error(`\n${message}\n`);
  }
  console.error('usage: bun run build [--target=<target>] [--all]');
  console.error(`\n  on this host (${host.os}/${host.arch}) you can build:`);
  console.error(`    ${host.buildTargets.join(', ')}`);
  const impossible = (['linux', 'macos', 'windows', 'ipa'] as const).filter(
    target => !host.buildTargets.includes(target),
  );
  if (impossible.length > 0) {
    console.error('\n  you cannot build here:');
    for (const target of impossible) {
      console.error(`    ${target.padEnd(8)} ${whyImpossible(target, host)}`);
    }
  }
  console.error('');
  process.exit(1);
}

/** The default: the server plus this host's own desktop target. Enough to run Nelle locally. */
function defaultTargets(): BuildTarget[] {
  // `HostOs` and `BuildTarget` overlap on the three desktop names, so the host's own OS is always a
  // valid target here -- but say so in the type rather than casting the array, or `.includes()`
  // widens the element to `string`.
  const candidates: BuildTarget[] = ['server', host.os];
  return candidates.filter(target => host.buildTargets.includes(target));
}

const targets: BuildTarget[] = buildAll
  ? host.buildTargets
  : requested
    ? [requested as BuildTarget]
    : defaultTargets();

// Refuse the impossible up front, before any toolchain is invoked.
for (const target of targets) {
  const reason = whyImpossible(target, host);
  if (reason) {
    usage(`Cannot build \`${target}\` on ${host.os}: ${reason}`);
  }
}

const outDir = path.join('dist', host.os);
await fs.mkdir(outDir, {recursive: true});

async function run(label: string, command: string[], cwd?: string): Promise<void> {
  console.log(`\n▸ ${label}`);
  const proc = Bun.spawn(command, {cwd, stdout: 'inherit', stderr: 'inherit'});
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n  build failed: ${command.join(' ')}`);
    process.exit(code);
  }
}

/**
 * Build the server, then **run it and feed it a PDF**.
 *
 * The smoke test is the point. `bun build --compile` reports success on a binary whose PDF path is
 * broken, because the failure is a *runtime* file resolution inside the bundle. Nothing but running
 * it can tell the difference.
 */
async function buildServer(): Promise<void> {
  const binary = path.join(outDir, host.os === 'windows' ? 'nelle-server.exe' : 'nelle-server');
  await run('server binary', [
    'bun',
    'build',
    '--compile',
    'apps/server/src/index.ts',
    '--outfile',
    binary,
  ]);

  console.log('\n▸ smoke-testing the binary (a build that cannot read a PDF must never ship)');
  const failure = await smokeTestBinary(binary);
  if (failure) {
    console.error(`  the binary REFUSED a PDF: ${failure}`);
    console.error('  (this is the bug that shipped once: a successful build is not a working');
    console.error('   artifact. See tests/unit/compiledBinary.test.ts.)');
    process.exit(1);
  }
  console.log('  ✔ the binary reads a PDF');
}

/**
 * Runs the built binary and feeds it a PDF. Returns the failure message, or `null` on success.
 *
 * **It returns rather than exiting, and that is load-bearing.** `process.exit()` inside a `try`
 * terminates the process *immediately* — the `finally` never runs. An earlier version of this
 * function exited on failure from inside the try, which left the spawned server **alive on port
 * 8791**; the next build's smoke test then connected to the *previous, broken* server and reported
 * a failure that had already been fixed. The kill has to happen before anyone can exit, so the
 * exiting is the caller's job.
 */
async function smokeTestBinary(binary: string): Promise<string | null> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-smoke-'));
  const port = 8791;
  const server = Bun.spawn([path.resolve(binary)], {
    env: {
      ...process.env,
      NELLE_DATA_DIR: path.join(workspace, 'data'),
      NELLE_PORT: String(port),
      // A port nothing is on. The runtime probe calls any healthy llama.cpp on the configured port
      // "running", so the default 8080 would adopt the developer's own llama-server.
      NELLE_LLAMA_PORT: '18092',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  try {
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
          up = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await Bun.sleep(200);
    }
    if (!up) {
      return 'the built binary never came up';
    }

    const pdf = [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]' +
        '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
      '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      '5 0 obj<</Length 54>>stream',
      'BT /F1 12 Tf 20 50 Td (Nelle build smoke test) Tj ET',
      'endstream endobj',
      'trailer<</Root 1 0 R>>',
    ].join('\n');

    const form = new FormData();
    form.append('file', new Blob([Buffer.from(pdf, 'latin1')], {type: 'application/pdf'}), 'a.pdf');
    const response = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
      method: 'POST',
      body: form,
    });
    const body = (await response.json()) as {kind?: string; error?: {message?: string}};

    if (response.status !== 201 || body.kind !== 'pdf') {
      return body.error?.message ?? `HTTP ${response.status}`;
    }
    return null;
  } finally {
    server.kill();
    await server.exited;
    await fs.rm(workspace, {recursive: true, force: true});
  }
}

const FLUTTER: Partial<Record<BuildTarget, string[]>> = {
  linux: ['flutter', 'build', 'linux', '--release'],
  macos: ['flutter', 'build', 'macos', '--release'],
  windows: ['flutter', 'build', 'windows', '--release'],
  apk: ['flutter', 'build', 'apk', '--release'],
  ipa: ['flutter', 'build', 'ipa', '--release'],
  web: ['flutter', 'build', 'web', '--release'],
};

console.log(`Nelle — build (${host.os}/${host.arch})`);
console.log(`  targets: ${targets.join(', ')}`);

for (const target of targets) {
  if (target === 'server') {
    await buildServer();
    continue;
  }
  const command = FLUTTER[target];
  if (!command) {
    usage(`no build command for \`${target}\``);
  }
  if (!Bun.which('flutter')) {
    console.error(`\n  \`${target}\` needs Flutter, which is not on PATH. Run: bun run doctor`);
    process.exit(1);
  }
  await run(`client: ${target}`, command, 'apps/client');
}

console.log(`\nBuilt: ${targets.join(', ')}  ->  ${outDir}/ (server) and apps/client/build/\n`);
