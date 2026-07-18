import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import path from 'node:path';
import {afterEach, test} from 'bun:test';
import {strToU8, zipSync} from 'fflate';

import type {RuntimeInstallEvent} from '../../../src/contracts/runtime.ts';
import {createTestServer} from '../helpers/testServer.ts';
import {createTempPaths} from '../helpers/paths.ts';

/**
 * llama.cpp deliberately **floats to latest** — users must never wait on a Nelle release for an
 * upstream fix — so the safety story is not a pin. It is these three properties, and each has a
 * test:
 *
 * 1. **Integrity**: a downloaded release archive is verified against the digest GitHub reports
 *    for the asset. A corrupted or tampered download must never be unpacked into the bin dir.
 * 2. **Rollback**: the version an install replaces is recorded (`previousVersion` on
 *    `RuntimeStatus`), and `POST /api/runtime/install/stream {version}` installs a *specific*
 *    version — together they make "step back to yesterday's" one request.
 * 3. **A failed install never eats the rollback target**: `.previous-version` is written only
 *    after the new archive is verified, so a bad download leaves the record untouched.
 *
 * These run the real `installFromGithubRelease` against a faked GitHub (the release JSON and
 * the asset bytes), which is why they skip on Linux — there an install is a git clone plus a
 * cmake build, and the shared pieces (recording, targeted versions, the request schema) are
 * exercised here through the platform-independent code.
 */

const isLinux = process.platform === 'linux';
const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

const originalFetch = globalThis.fetch;
const originalServerPath = process.env.LLAMA_SERVER_PATH;
const originalLlamaPort = process.env.NELLE_LLAMA_PORT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
  }
  if (originalLlamaPort === undefined) {
    delete process.env.NELLE_LLAMA_PORT;
  } else {
    process.env.NELLE_LLAMA_PORT = originalLlamaPort;
  }
});

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

/** A real zip a real `unzip`/`Expand-Archive` can open, holding a fake llama-server. */
function fakeArchive(tag: string): Uint8Array<ArrayBuffer> {
  const zipped = zipSync({
    [`build/bin/${binaryName}`]: strToU8(`fake llama-server ${tag}\n`),
  });
  // Copy into a fresh ArrayBuffer-backed array: fflate's Uint8Array<ArrayBufferLike> is not
  // a `BodyInit` under the generic typed-array lib types.
  const copy = new Uint8Array(zipped.length);
  copy.set(zipped);
  return copy;
}

/** The asset name `pickReleaseAsset` will match on this host. */
const assetName =
  process.platform === 'win32' ? 'llama-win-avx2-x64.zip' : `llama-macos-${process.arch}.zip`;

/**
 * Fakes GitHub: `/releases/latest` and `/releases/tags/:tag` answer release JSON, and the
 * asset URL answers the archive bytes. `digest` defaults to the honest sha256; pass a lie to
 * test the refusal.
 */
function fakeGithub(options: {latest: string; digestFor?: (tag: string) => string | undefined}) {
  const requested: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const tagMatch = /releases\/tags\/([^/?]+)$/.exec(url);
    const tag = tagMatch ? decodeURIComponent(tagMatch[1]) : options.latest;
    if (url.includes('/releases/')) {
      const bytes = fakeArchive(tag);
      const digest = options.digestFor ? options.digestFor(tag) : `sha256:${sha256(bytes)}`;
      return Response.json({
        tag_name: tag,
        assets: [
          {
            name: assetName,
            browser_download_url: `https://fake.local/${tag}/${assetName}`,
            ...(digest ? {digest} : {}),
          },
        ],
      });
    }
    const downloadTag = /fake\.local\/([^/]+)\//.exec(url)?.[1] ?? options.latest;
    return new Response(fakeArchive(downloadTag));
  }) as typeof fetch;
  return requested;
}

function eventsFrom(body: string): RuntimeInstallEvent[] {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)) as {data: RuntimeInstallEvent})
    .map(envelope => envelope.data);
}

test.skipIf(isLinux)(
  'a verified install records the replaced version, and {version} reinstalls it',
  async () => {
    process.env.NELLE_LLAMA_PORT = '18099';
    delete process.env.LLAMA_SERVER_PATH;
    const paths = await createTempPaths();
    const app = await createTestServer(paths);
    const requested = fakeGithub({latest: 'b200'});

    try {
      // First install: latest (b200). Nothing to record as previous yet.
      let response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      let events = eventsFrom(response.body);
      let completed = events.at(-1);
      assert.ok(completed?.type === 'runtime.install.completed', JSON.stringify(events.at(-1)));
      assert.equal(completed.runtime.installedVersion, 'b200');
      assert.equal(completed.runtime.previousVersion, null);
      assert.ok(fsSync.existsSync(path.join(paths.llamaBinDir, binaryName)));

      // Second install: latest moved on (b201). b200 becomes the rollback target.
      fakeGithub({latest: 'b201'});
      response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      completed = eventsFrom(response.body).at(-1);
      assert.ok(completed?.type === 'runtime.install.completed');
      assert.equal(completed.runtime.installedVersion, 'b201');
      assert.equal(completed.runtime.previousVersion, 'b200');

      // The revert: install the previous version explicitly. It must hit the tags URL, not
      // /releases/latest, and the replaced b201 becomes the new rollback target.
      const tagRequests = fakeGithub({latest: 'b201'});
      response = await app.inject({
        method: 'POST',
        url: '/api/runtime/install/stream',
        payload: {version: 'b200'},
      });
      completed = eventsFrom(response.body).at(-1);
      assert.ok(completed?.type === 'runtime.install.completed');
      assert.equal(completed.runtime.installedVersion, 'b200');
      assert.equal(completed.runtime.previousVersion, 'b201');
      assert.ok(
        tagRequests.some(url => url.includes('/releases/tags/b200')),
        'an explicit version must resolve through /releases/tags/, never /releases/latest',
      );

      // The verified-digest line reached the streamed output.
      const output = eventsFrom(response.body)
        .filter(event => event.type === 'runtime.install.output')
        .map(event => (event.type === 'runtime.install.output' ? event.line : ''))
        .join('\n');
      assert.match(output, /Verified sha256 digest/);
      assert.ok(requested.length > 0);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(isLinux)(
  'a digest mismatch refuses the install and leaves the rollback target alone',
  async () => {
    process.env.NELLE_LLAMA_PORT = '18099';
    delete process.env.LLAMA_SERVER_PATH;
    const paths = await createTempPaths();
    const app = await createTestServer(paths);

    try {
      // A good install first, so there is something a corrupted update could destroy.
      fakeGithub({latest: 'b300'});
      let response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      let last = eventsFrom(response.body).at(-1);
      assert.ok(last?.type === 'runtime.install.completed');

      // Now an update whose digest does not match the bytes.
      fakeGithub({latest: 'b301', digestFor: () => `sha256:${'0'.repeat(64)}`});
      response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
      last = eventsFrom(response.body).at(-1);
      assert.ok(last?.type === 'runtime.install.failed', JSON.stringify(last));
      assert.match(last.error.message, /Checksum mismatch/);

      // The failed update ate nothing: b300 is still installed, and the rollback record was
      // not overwritten by the refused archive.
      const status = await app.inject({method: 'GET', url: '/api/runtime'});
      const runtime = JSON.parse(status.body) as {
        installedVersion: string | null;
        previousVersion: string | null;
      };
      assert.equal(runtime.installedVersion, 'b300');
      assert.equal(runtime.previousVersion, null);
    } finally {
      await app.close();
    }
  },
);

test.skipIf(isLinux)('an asset without a published digest still installs', async () => {
  process.env.NELLE_LLAMA_PORT = '18099';
  delete process.env.LLAMA_SERVER_PATH;
  const paths = await createTempPaths();
  const app = await createTestServer(paths);

  try {
    fakeGithub({latest: 'b400', digestFor: () => undefined});
    const response = await app.inject({method: 'POST', url: '/api/runtime/install/stream'});
    const events = eventsFrom(response.body);
    const last = events.at(-1);
    assert.ok(last?.type === 'runtime.install.completed', JSON.stringify(last));
    const output = events
      .filter(event => event.type === 'runtime.install.output')
      .map(event => (event.type === 'runtime.install.output' ? event.line : ''))
      .join('\n');
    assert.match(output, /skipping checksum verification/);
  } finally {
    await app.close();
  }
});

test('a malformed body is an ordinary 400, not a half-open stream', async () => {
  // Runs on every platform: the zod parse happens before the platform branch and before the
  // SSE stream opens.
  process.env.NELLE_LLAMA_PORT = '18099';
  const app = await createTestServer(await createTempPaths());
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/runtime/install/stream',
      payload: {version: 123},
    });
    assert.equal(response.statusCode, 400);
    assert.doesNotMatch(response.headers['content-type'] ?? '', /event-stream/);
  } finally {
    await app.close();
  }
});
