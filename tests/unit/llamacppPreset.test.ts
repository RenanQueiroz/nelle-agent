import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {LlamaCppManager} from '../../apps/server/src/llamacpp.ts';
import type {AppPaths} from '../../apps/server/src/paths.ts';
import {AppStore} from '../../apps/server/src/store.ts';

test('new Hugging Face imports use stable canonical section ids', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);

  const model = await store.addHuggingFaceModel({
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
  });

  assert.equal(model.id, 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL');
  assert.equal(model.presetName, model.id);
});

test('writePreset uses lossless models.ini updates for managed keys', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  await fs.mkdir(path.dirname(paths.llamaPresetPath), {recursive: true});
  await fs.writeFile(
    paths.llamaPresetPath,
    [
      '# keep this comment',
      'version = 1',
      '',
      '[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]',
      'custom-flag = keep-me',
      'load-on-startup = true',
      '',
    ].join('\n'),
  );

  const model = await store.addHuggingFaceModel({
    repoId: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    quant: 'UD-Q4_K_XL',
    name: 'Qwen 35B Q4 XL',
  });
  await store.updateGlobalModelParams({c: '16384', threads: '8'});
  await store.updateModel(model.id, {params: {'ctx-size': '32768', 'ubatch-size': '256'}});
  const llama = new LlamaCppManager(paths, store);
  await llama.writePreset(model);

  const written = await fs.readFile(paths.llamaPresetPath, 'utf8');
  const backup = await fs.readFile(`${paths.llamaPresetPath}.bak`, 'utf8');

  assert.match(written, /# keep this comment/);
  assert.match(written, /custom-flag = keep-me/);
  assert.match(written, /\[\*\]\n(?:.*\n)*c = 16384/);
  assert.match(written, /threads = 8/);
  assert.match(written, /hf-repo = unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/);
  assert.match(written, /alias = Qwen 35B Q4 XL/);
  assert.match(written, /ctx-size = 32768/);
  assert.match(written, /ubatch-size = 256/);
  assert.doesNotMatch(written, /load-on-startup/);
  assert.match(backup, /load-on-startup = true/);
});

test('removeModelSection deletes removed model from models.ini', async () => {
  const paths = await createTempPaths();
  const store = new AppStore(paths);
  const model = await store.addHuggingFaceModel({
    repoId: 'repo/model',
    quant: 'UD-Q4_K_M',
    name: 'Model Q4',
  });
  const llama = new LlamaCppManager(paths, store);
  await llama.writePreset();
  await store.removeModel(model.id);
  await llama.removeModelSection(model.id);
  await llama.writePreset();

  const written = await fs.readFile(paths.llamaPresetPath, 'utf8');
  assert.doesNotMatch(written, /\[repo\/model:Q4_K_M\]/);
});

async function createTempPaths(): Promise<AppPaths> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-test-'));
  const repoRoot = path.resolve('.');
  const llamaDir = path.join(dataDir, 'llama');
  const piDir = path.join(dataDir, 'pi');

  return {
    repoRoot,
    dataDir,
    downloadsDir: path.join(dataDir, 'downloads'),
    attachmentsDir: path.join(dataDir, 'attachments'),
    llamaDir,
    llamaBinDir: path.join(llamaDir, 'bin'),
    llamaSrcDir: path.join(llamaDir, 'src'),
    llamaPresetPath: path.join(llamaDir, 'models.ini'),
    llamaPidPath: path.join(llamaDir, 'llama-server.pid.json'),
    llamaLogPath: path.join(dataDir, 'logs', 'llama-server.log'),
    piDir,
    piSessionsDir: path.join(piDir, 'sessions'),
    piAuthPath: path.join(piDir, 'auth.json'),
    piModelsPath: path.join(piDir, 'models.json'),
    settingsDbPath: path.join(dataDir, 'settings.sqlite'),
    statePath: path.join(dataDir, 'state.json'),
    webDistDir: path.join(repoRoot, 'dist', 'web'),
  };
}
