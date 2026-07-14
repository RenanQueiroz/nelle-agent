import {test} from 'bun:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {ensureServerCert} from '../../../apps/server/src/auth/tls.ts';
import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';
import {removeTemp} from '../helpers/platform.ts';

test('ensureServerCert generates, persists, and reuses a stable self-signed cert', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-tls-'));
  // `ensureServerCert` only reads `dataDir`.
  const paths = {dataDir: dir} as unknown as AppPaths;
  try {
    const first = await ensureServerCert(paths);
    assert.match(first.certPem, /-----BEGIN CERTIFICATE-----/);
    assert.match(first.keyPem, /PRIVATE KEY-----/);
    // 32 uppercase hex byte-pairs joined by colons, like `openssl`.
    assert.match(first.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

    await assert.doesNotReject(fs.access(path.join(dir, 'tls', 'cert.pem')));
    await assert.doesNotReject(fs.access(path.join(dir, 'tls', 'key.pem')));

    // Reused, not regenerated: the pinned fingerprint must survive a restart.
    const second = await ensureServerCert(paths);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.equal(second.certPem, first.certPem);
  } finally {
    await removeTemp(dir);
  }
});
