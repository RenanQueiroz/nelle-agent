import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {afterEach, test} from 'bun:test';

import {LlamaInstall} from '../../../apps/server/src/llama/install.ts';
import type {AppPaths} from '../../../apps/server/src/lib/paths.ts';
import type {RuntimeStatus} from '../../../apps/server/src/lib/types.ts';
import {createTempPaths} from '../helpers/paths.ts';

/**
 * Uninstalling llama.cpp deletes what an install *put there* — the binaries, and on Linux the
 * cloned source — and nothing else. Two things it must never touch: `models.ini` (the user's model
 * catalog, which lives in the same `llama/` directory) and an `external` binary the user pointed
 * `LLAMA_SERVER_PATH` at, which Nelle did not put there and will not remove.
 */

const originalServerPath = process.env.LLAMA_SERVER_PATH;

afterEach(() => {
  if (originalServerPath === undefined) {
    delete process.env.LLAMA_SERVER_PATH;
  } else {
    process.env.LLAMA_SERVER_PATH = originalServerPath;
  }
});

function stubStatus(): RuntimeStatus {
  return {
    platform: 'linux',
    arch: 'x64',
    dataDir: '/data',
    workspaceDir: '/home/user',
    binaryPath: null,
    logPath: '/data/logs/llama-server.log',
    installMode: 'source-master',
    installed: false,
    installedVersion: null,
    previousVersion: null,
    latestVersion: null,
    updateAvailable: false,
    running: false,
    pid: null,
    host: '127.0.0.1',
    port: 8080,
    modelsMax: 1,
    sleepIdleSeconds: 90,
    activeModelId: null,
    lastError: null,
  };
}

/** Lays down what a real install leaves on disk: a binary, a cloned source tree, a pid file — and,
 * crucially, `models.ini` in the same `llama/` directory. */
async function seedInstall(paths: AppPaths): Promise<void> {
  await fs.mkdir(paths.llamaBinDir, {recursive: true});
  await fs.writeFile(path.join(paths.llamaBinDir, 'llama-server'), 'ELF');
  await fs.mkdir(path.join(paths.llamaSrcDir, '.git'), {recursive: true});
  await fs.writeFile(path.join(paths.llamaSrcDir, 'README.md'), 'source');
  await fs.writeFile(paths.llamaPresetPath, '[*]\nfitc = 32768\n');
  await fs.writeFile(paths.llamaPidPath, '{"pid":1}');
}

function makeInstall(paths: AppPaths): LlamaInstall {
  return new LlamaInstall(paths, {
    status: async () => stubStatus(),
    reportError: () => {},
  });
}

test('uninstall deletes the binary and source, and keeps models.ini', async () => {
  delete process.env.LLAMA_SERVER_PATH;
  const paths = await createTempPaths();
  await seedInstall(paths);

  await makeInstall(paths).uninstall();

  assert.equal(fsSync.existsSync(paths.llamaBinDir), false, 'the binaries are deleted');
  assert.equal(fsSync.existsSync(paths.llamaSrcDir), false, 'the cloned source is deleted');
  assert.equal(fsSync.existsSync(paths.llamaPidPath), false, 'the stale pid file is deleted');
  // The model catalog lives in the same `llama/` directory. Deleting the whole directory — the
  // obvious implementation — would lose every model the user configured.
  assert.equal(fsSync.existsSync(paths.llamaPresetPath), true, 'models.ini survives');
});

test('uninstall refuses an external binary, and deletes nothing', async () => {
  // `LLAMA_SERVER_PATH` is the user's own binary. Nelle neither built nor downloaded it, so it has
  // no business deleting it — and must not touch the rest of the tree on the way to refusing.
  process.env.LLAMA_SERVER_PATH = '/usr/local/bin/llama-server';
  const paths = await createTempPaths();
  await seedInstall(paths);

  await assert.rejects(
    () => makeInstall(paths).uninstall(),
    (error: Error & {code?: string}) => {
      assert.equal(error.code, 'runtime_not_uninstallable');
      return true;
    },
  );

  assert.equal(fsSync.existsSync(paths.llamaBinDir), true, 'nothing was deleted');
  assert.equal(fsSync.existsSync(paths.llamaSrcDir), true, 'nothing was deleted');
});
