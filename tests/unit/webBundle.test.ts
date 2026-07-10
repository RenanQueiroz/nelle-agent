import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const WEB_SRC = path.resolve('apps/web/src');
const WEB_DIST_ASSETS = path.resolve('dist/web/assets');

test('the web app does not import pdfjs-dist', async () => {
  // PDF text extraction and page rendering run on the server. `pdfjs-dist` is
  // 36 MB installed and needs a DOM canvas, which React Native does not have.
  const offenders: string[] = [];
  for (const file of await sourceFiles(WEB_SRC)) {
    const contents = await fs.readFile(file, 'utf8');
    if (contents.includes('pdfjs-dist')) {
      offenders.push(path.relative(WEB_SRC, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('no built chunk carries the PDF renderer', async () => {
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
