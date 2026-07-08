import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  canonicalizeHuggingFaceRef,
  canonicalizeQuantTag,
  getModelsIniValue,
  parseModelsIni,
  removeModelsIniSection,
  sectionIdForHuggingFaceRef,
  stringifyModelsIni,
  upsertModelsIniValues,
  validateModelsIniDocument,
  writeModelsIniAtomic,
} from '../../packages/shared/src/modelsIni.ts';

test('models.ini parser round trips comments, spacing, and malformed lines', () => {
  const source = [
    '# global comment',
    'version    =    1',
    '',
    '[*]',
    'c = 8192',
    'malformed line',
    '',
    '[repo/model:Q4_K_M] ; inline section comment',
    'hf-repo = repo/model:UD-Q4_K_M',
    'alias = Demo',
    '',
  ].join('\n');

  const document = parseModelsIni(source);

  assert.equal(stringifyModelsIni(document), source);
  assert.equal(getModelsIniValue(document, '*', 'c'), '8192');
  assert.equal(getModelsIniValue(document, 'repo/model:Q4_K_M', 'alias'), 'Demo');
});

test('models.ini upsert updates managed keys while preserving unknown keys', () => {
  const source = [
    'version = 1',
    '',
    '[repo/model:Q4_K_M]',
    'custom-flag = keep-me',
    'alias = Old Name',
    '',
  ].join('\n');

  const updated = upsertModelsIniValues(parseModelsIni(source), 'repo/model:Q4_K_M', {
    alias: 'New Name',
    'hf-repo': 'repo/model:UD-Q4_K_M',
  });
  const text = stringifyModelsIni(updated);

  assert.match(text, /custom-flag = keep-me/);
  assert.match(text, /alias = New Name/);
  assert.match(text, /hf-repo = repo\/model:UD-Q4_K_M/);
});

test('models.ini section removal deletes only the selected section', () => {
  const source = [
    'version = 1',
    '',
    '[repo/one:Q4_K_M]',
    'hf-repo = repo/one:Q4_K_M',
    '',
    '[repo/two:Q5_K_M]',
    'hf-repo = repo/two:Q5_K_M',
    '',
  ].join('\n');

  const text = stringifyModelsIni(
    removeModelsIniSection(parseModelsIni(source), 'repo/one:Q4_K_M'),
  );

  assert.doesNotMatch(text, /repo\/one/);
  assert.match(text, /repo\/two:Q5_K_M/);
});

test('models.ini validation reports duplicate sections and duplicate editable keys', () => {
  const document = parseModelsIni(
    ['[*]', 'c = 8192', 'c = 4096', '', '[model]', 'alias = one', '[model]', 'alias = two'].join(
      '\n',
    ),
  );

  const issues = validateModelsIniDocument(document);

  assert.ok(issues.some(issue => issue.code === 'duplicate_key' && issue.key === 'c'));
  assert.ok(
    issues.some(issue => issue.code === 'duplicate_section' && issue.sectionName === 'model'),
  );
});

test('Hugging Face refs keep exact repo while canonicalizing quant tags', () => {
  assert.equal(canonicalizeQuantTag('UD-Q4_K_XL'), 'Q4_K_XL');
  assert.equal(canonicalizeQuantTag('Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf'), 'Q4_K_XL');
  assert.equal(canonicalizeQuantTag('model.Q5_K_M-00001-of-00002.gguf'), 'Q5_K_M');
  assert.equal(
    canonicalizeHuggingFaceRef('unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL'),
    'unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL',
  );
});

test('Hugging Face section id adds stable suffix only for exact-ref collisions', () => {
  const ref = 'repo/model:UD-Q4_K_M';

  assert.equal(
    sectionIdForHuggingFaceRef(ref, [{sectionId: 'repo/model:Q4_K_M', hfRepo: ref}]),
    'repo/model:Q4_K_M',
  );
  assert.match(
    sectionIdForHuggingFaceRef(ref, [
      {sectionId: 'repo/model:Q4_K_M', hfRepo: 'repo/model:Q4_K_M'},
    ]),
    /^repo\/model:Q4_K_M-[a-f0-9]{8}$/,
  );
});

test('atomic models.ini writes keep a backup of previous content', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nelle-models-ini-'));
  const filePath = path.join(directory, 'models.ini');

  await fs.writeFile(filePath, 'version = 1\n');
  await writeModelsIniAtomic(filePath, parseModelsIni('version = 2\n'));

  assert.equal(await fs.readFile(filePath, 'utf8'), 'version = 2\n');
  assert.equal(await fs.readFile(`${filePath}.bak`, 'utf8'), 'version = 1\n');
});
