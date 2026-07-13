import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {test} from 'bun:test';

const WEB_SRC = path.resolve('apps/web/src');
const WEB_DIST_ASSETS = path.resolve('dist/web/assets');

/** Server-only dependencies, and why the web bundle must never learn their names. */
const SERVER_ONLY_PACKAGES = [
  // PDF text extraction and page rendering run on the server. 36 MB installed,
  // and it needs a DOM canvas, which React Native does not have.
  'pdfjs-dist',
  // GGUF headers are parsed from the local blob, on the server. It pulls
  // `@huggingface/tasks`; together 5.8 MB installed, and a browser has no file.
  '@huggingface/gguf',
];

test('the web app imports no server-only package', async () => {
  const offenders: string[] = [];
  for (const file of await sourceFiles(WEB_SRC)) {
    const contents = await fs.readFile(file, 'utf8');
    for (const dependency of SERVER_ONLY_PACKAGES) {
      if (contents.includes(dependency)) {
        offenders.push(`${path.relative(WEB_SRC, file)} -> ${dependency}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no built chunk carries a server-only package', async () => {
  let assets: string[];
  try {
    assets = await fs.readdir(WEB_DIST_ASSETS);
  } catch {
    // `npm run build:web` has not run in this working tree. The source check
    // above is the invariant; this one is the belt.
    return;
  }
  const pdfChunks = assets.filter(name => /pdf/i.test(name));
  assert.deepEqual(pdfChunks, [], 'a pdf chunk means pdfjs is back in the bundle');

  const bundled = await Promise.all(
    assets
      .filter(name => name.endsWith('.js'))
      .map(name => fs.readFile(path.join(WEB_DIST_ASSETS, name), 'utf8')),
  );
  for (const dependency of SERVER_ONLY_PACKAGES) {
    assert.equal(
      bundled.some(chunk => chunk.includes(dependency)),
      false,
      `${dependency} reached a built chunk`,
    );
  }
});

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {withFileTypes: true});
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(absolutePath)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

test('the web bundle carries no zod', async () => {
  // The rule existed and nothing enforced it, so it was broken the first time someone
  // reached into `contracts.ts` for a shared *string*: importing anything from a module
  // that imports zod pulls the whole validator into the browser -- 67 kB, to render one
  // sentence. Shared copy the web needs lives in a zod-free module (`hostToolsCopy.ts`,
  // `attachments.ts`, `settingsKeys.ts`), which is why those exist.
  //
  // The server validates. The browser renders. A validator in the browser is a second
  // copy of a rule that already has an owner.
  const files = await fs.readdir(WEB_DIST_ASSETS).catch(() => []);
  const scripts = files.filter(file => file.endsWith('.js'));
  assert.ok(scripts.length > 0, 'run: bun run build:web');

  for (const script of scripts) {
    const source = await fs.readFile(path.join(WEB_DIST_ASSETS, script), 'utf8');
    assert.doesNotMatch(
      source,
      /ZodError|ZodIssueCode|\$ZodType/,
      `${script} carries zod -- something under apps/web/src imports a module that imports it`,
    );
  }
});
