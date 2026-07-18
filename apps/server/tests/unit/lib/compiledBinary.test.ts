import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, test} from 'bun:test';
import {removeTemp} from '../helpers/platform.ts';

/**
 * **The one test that runs the artifact we would actually ship.**
 *
 * Every other test exercises the server *in process*, where `node_modules` is on disk and every
 * runtime `require` resolves. `bun build --compile` produces something different: a single
 * executable whose modules live in a virtual filesystem rooted at `/$bunfs/root`. Anything that
 * resolves a file **at runtime, relative to its own module path** breaks there — and nowhere else.
 *
 * That is not hypothetical. `bun run build:binary` reported success (3,134 modules, 164 MB), the
 * binary started, served `/api/health`, and accepted a text upload — and **could not read a single
 * PDF**, because pdfjs does this (`display/node_utils.js`):
 *
 * ```js
 * const require = process.getBuiltinModule("module").createRequire(import.meta.url);
 * canvas = require("@napi-rs/canvas");            // fails: import.meta.url is inside the bundle
 * if (!globalThis.DOMMatrix) globalThis.DOMMatrix = canvas.DOMMatrix;
 * ```
 *
 * and then, one layer down, loads its worker with `await import('./pdf.worker.mjs')` — a sibling
 * path that does not exist in the bundle either. Both are fixed by installing the globals
 * ourselves before pdfjs loads (`attachmentIngest.ts:loadPdfJs`); Bun's native-module embedding was
 * never the problem, and a plain `import('@napi-rs/canvas')` works in a compiled binary.
 *
 * A *successful build* is not a working artifact. This is the test that knows the difference, and
 * it is why "build it on every push" would have bought false confidence rather than safety.
 */

const BUILD_TIMEOUT_MS = 120_000;
const PORT = 8793;

const temporaries: string[] = [];
afterAll(async () => {
  await Promise.all(temporaries.map(dir => removeTemp(dir)));
});

async function pdfFixture(directory: string): Promise<string> {
  // A minimal, real PDF with a text layer. Written by hand rather than committed, because a
  // binary fixture in git is the sort of thing this repository has already had to clean up once.
  const file = path.join(directory, 'text-layer.pdf');
  const body = [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]' +
      '/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj',
    '4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    '5 0 obj<</Length 54>>stream',
    'BT /F1 12 Tf 20 50 Td (Nelle compiled binary PDF) Tj ET',
    'endstream endobj',
    'trailer<</Root 1 0 R>>',
  ].join('\n');
  await fs.writeFile(file, body, 'latin1');
  return file;
}

test(
  'the COMPILED binary reads a PDF — the source-only tests cannot see this',
  async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-binary-'));
    temporaries.push(workspace);
    const binary = path.join(workspace, 'nelle-server');

    const build = Bun.spawnSync(
      ['bun', 'build', '--compile', 'apps/server/src/index.ts', '--outfile', binary],
      {stdout: 'pipe', stderr: 'pipe'},
    );
    assert.equal(build.exitCode, 0, `the build failed: ${build.stderr.toString()}`);

    const dataDir = path.join(workspace, 'data');
    const server = Bun.spawn([binary], {
      env: {
        ...process.env,
        NELLE_DATA_DIR: dataDir,
        NELLE_PORT: String(PORT),
        // A port nothing is on. The runtime probe calls any healthy llama.cpp on the configured
        // port "running", so the default 8080 would adopt the developer's own llama-server.
        NELLE_LLAMA_PORT: '18093',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    try {
      const deadline = Date.now() + 30_000;
      let up = false;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) {
            up = true;
            break;
          }
        } catch {
          // not listening yet
        }
        await Bun.sleep(200);
      }
      assert.ok(up, 'the compiled binary never came up');

      const form = new FormData();
      const pdf = await pdfFixture(workspace);
      form.append('file', new Blob([await fs.readFile(pdf)], {type: 'application/pdf'}), 'a.pdf');

      const response = await fetch(`http://127.0.0.1:${PORT}/api/uploads`, {
        method: 'POST',
        body: form,
      });
      const body = (await response.json()) as {
        kind?: string;
        pageCount?: number;
        error?: {message?: string};
      };

      // The failure this test exists for: `DOMMatrix is not defined`, or `Cannot find module
      // './pdf.worker.mjs'`. Assert the *reason*, so a regression names itself.
      assert.equal(
        response.status,
        201,
        `the compiled binary refused a PDF: ${body.error?.message ?? '(no message)'}`,
      );
      assert.equal(body.kind, 'pdf');
      assert.equal(body.pageCount, 1);
    } finally {
      server.kill();
      await server.exited;
    }
  },
  BUILD_TIMEOUT_MS,
);
