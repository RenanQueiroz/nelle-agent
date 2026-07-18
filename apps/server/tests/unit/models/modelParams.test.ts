import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'bun:test';

import {
  acceptedModelParamKeys,
  editDistance,
  invalidModelParamsCode,
  llamaOptionCatalogue,
  parseLlamaOptionCatalogue,
  suggestModelParamKey,
  validateModelParams,
  type LlamaOption,
} from '../../../src/contracts/modelParams.ts';

/** 647 lines captured from llama.cpp `ee445f9`, so the test never needs a binary. */
const HELP_TEXT = fs.readFileSync('apps/server/tests/fixtures/llama-server-help.txt', 'utf8');
const CATALOGUE = llamaOptionCatalogue(HELP_TEXT);
const OPTIONS = CATALOGUE.options;
const ACCEPTED = acceptedModelParamKeys(OPTIONS);

function optionFor(key: string): LlamaOption {
  const option = OPTIONS.find(entry => entry.keys.includes(key));
  assert.ok(option, `no option carries the key ${key}`);
  return option;
}

test('every spelling is a key, and so is every environment variable name', () => {
  // `common/preset.cpp`'s `get_map_key_opt` maps an option by each argument
  // spelling with the dashes stripped, and by each env name. All four of these
  // were confirmed against the real binary.
  for (const key of ['c', 'ctx-size', 'n-predict', 'LLAMA_ARG_TOP_K']) {
    assert.ok(ACCEPTED.has(key), `${key} must be an accepted preset key`);
  }

  const ctxSize = optionFor('c');
  assert.deepEqual(ctxSize.keys, ['c', 'ctx-size']);
  assert.deepEqual(ctxSize.env, ['LLAMA_ARG_CTX_SIZE']);
  assert.equal(ctxSize.valueHint, 'N');
  assert.match(ctxSize.help, /size of the prompt context/);
  // The `(env: ...)` marker belongs to the metadata, not to the help text.
  assert.doesNotMatch(ctxSize.help, /env:/);

  // Three spellings, and the long one is not the first.
  assert.deepEqual(optionFor('n').keys, ['n', 'predict', 'n-predict']);
});

test('a flag has no value hint, and a hint may contain spaces', () => {
  assert.equal(optionFor('swa-full').valueHint, undefined);
  assert.equal(optionFor('h').valueHint, undefined);

  assert.equal(optionFor('cpu-strict').valueHint, '<0|1>');
  assert.equal(optionFor('poll').valueHint, '<0...100>');
  assert.equal(optionFor('fa').valueHint, '[on|off|auto]');
  assert.equal(optionFor('Cr').valueHint, 'lo-hi');
  // Two tokens, and no description on the same line.
  assert.equal(optionFor('control-vector-layer-range').valueHint, 'START END');
  // A hint with interior spaces, from an entry whose spellings reach the
  // description column and push the description onto the next line.
  assert.equal(
    optionFor('override-tensor-draft').valueHint,
    '<tensor name pattern>=<buffer type>,...',
  );
  assert.match(optionFor('override-tensor-draft').help, /override tensor buffer type/i);
});

test('the accept-set is case-sensitive, because llama.cpp is', () => {
  // `-c` is `--ctx-size`; `-C` is `--cpu-mask`. Folding case would merge them.
  assert.deepEqual(optionFor('c').keys, ['c', 'ctx-size']);
  assert.deepEqual(optionFor('C').keys, ['C', 'cpu-mask']);
  assert.ok(ACCEPTED.has('c') && ACCEPTED.has('C'));
});

test('the catalogue covers every section llama.cpp prints', () => {
  const sections = new Set(OPTIONS.map(option => option.section));
  assert.deepEqual(
    [...sections].sort(),
    // `preset` is Nelle's name for the options `--help` cannot print.
    ['common', 'example-specific', 'preset', 'sampling', 'speculative'],
  );
  // 246 lines in the fixture begin with a dash; four of them are section headers.
  assert.equal(OPTIONS.length, 244, '242 parsed entries, plus 2 preset-only keys --help hides');
  assert.equal(optionFor('temp').section, 'sampling');
  assert.equal(optionFor('models-preset').section, 'example-specific');

  // Every option carries at least one key and some help.
  for (const option of OPTIONS) {
    assert.ok(option.keys.length > 0);
    assert.ok(option.help.length > 0, `${option.keys[0]} has no help text`);
  }
});

test('the sampling keys Nelle points people at are all real', () => {
  for (const key of ['temp', 'top-k', 'top-p', 'min-p', 'seed', 'repeat-penalty']) {
    assert.ok(ACCEPTED.has(key), `${key} must be a real llama.cpp option`);
  }
});

test('help text Nelle cannot parse is unavailable, not a catalogue of two keys', () => {
  // The preset-only keys are always there, so "did anything parse?" cannot be
  // asked of the option count after they are added. A binary too old or too new
  // must skip the unknown-key check rather than reject every real option.
  assert.deepEqual(llamaOptionCatalogue('usage: llama-server [options]'), {
    available: false,
    options: [],
  });
  assert.deepEqual(llamaOptionCatalogue(''), {available: false, options: []});
  assert.equal(parseLlamaOptionCatalogue('usage: llama-server').length, 0);

  // One real option is enough to trust the format.
  const minimal = llamaOptionCatalogue('-c,    --ctx-size N   size of the prompt context\n');
  assert.equal(minimal.available, true);
  assert.equal(minimal.options.length, 3, 'the parsed option, plus the two preset-only keys');
});

test('the keys Nelle itself writes are accepted, including the ones --help hides', () => {
  // `stop-timeout` is `set_preset_only()` in `common/arg.cpp`, so it never
  // reaches the usage text -- but `get_map_key_opt` maps it, and `store.ts`
  // writes it into every model section. A catalogue read from `--help` alone
  // rejects Nelle's own `models.ini`. Found by parsing the real binary.
  for (const key of ['hf-repo', 'alias', 'stop-timeout', 'c']) {
    assert.ok(ACCEPTED.has(key), `Nelle writes ${key}, so the catalogue must accept it`);
  }
  assert.ok(ACCEPTED.has('load-on-startup'));
  assert.ok(ACCEPTED.has('__PRESET_STOP_TIMEOUT'), 'the preset-only env name is a key too');

  // And the memory levers `apps/server/AGENTS.md` promises the user.
  for (const key of ['ctk', 'ctv', 'ngl', 'cmoe', 'ncmoe', 'ot', 'offline']) {
    assert.ok(ACCEPTED.has(key), `${key} is a documented lever and must validate`);
  }
});

test('a typo is refused, and the nearest key is offered', () => {
  const invalid = validateModelParams(
    {temprature: '0.7', 'tpo-k': '40', c: '16384'},
    {acceptedKeys: ACCEPTED},
  );
  // Three typos should light up three rows on one save, not on three.
  assert.equal(invalid.length, 2);
  assert.deepEqual(
    invalid.map(entry => [entry.key, entry.reason, entry.suggestion]),
    [
      ['temprature', 'unknown', 'temperature'],
      ['tpo-k', 'unknown', 'top-k'],
    ],
  );
  assert.match(invalid[0]!.message, /not a llama\.cpp option/);
});

test('nothing close enough means no suggestion at all', () => {
  const [invalid] = validateModelParams({zzqqxx: '1'}, {acceptedKeys: ACCEPTED});
  assert.equal(invalid?.reason, 'unknown');
  assert.equal(invalid?.suggestion, undefined, 'a suggestion the user did not mean is worse');
});

test('an unavailable catalogue lets every key through, and still catches the rest', () => {
  // No binary installed. Refusing to save because Nelle could not run one would
  // be worse than the typo.
  assert.deepEqual(validateModelParams({temprature: '0.7'}, {}), []);
  assert.deepEqual(validateModelParams({temprature: '0.7'}, {acceptedKeys: new Set()}), []);

  // Syntax, reserved keys and duplicates do not need a binary.
  assert.equal(validateModelParams({'a=b': '1'}, {})[0]?.reason, 'syntax');
  assert.equal(validateModelParams({'': '1'}, {})[0]?.reason, 'syntax');
  assert.equal(validateModelParams({c: 'a\nb'}, {})[0]?.reason, 'syntax');
  assert.equal(
    validateModelParams({alias: 'x'}, {reservedKeys: new Set(['hf-repo', 'alias'])})[0]?.reason,
    'reserved',
  );
});

test('a key differing only in case is not a duplicate, because it is another option', () => {
  // `c` is `--ctx-size` and `C` is `--cpu-mask`. Lowercasing to compare them --
  // which is what the old validator did -- refused a legal pair of parameters.
  assert.deepEqual(validateModelParams({c: '16384', C: '0xff'}, {acceptedKeys: ACCEPTED}), []);

  // A key that only differs by whitespace really is the same key: both write `c`.
  const invalid = validateModelParams({c: '16384', ' c': '8192'}, {acceptedKeys: ACCEPTED});
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0]?.reason, 'duplicate');
});

test('the top-level code narrows only when every reason agrees', () => {
  assert.equal(
    invalidModelParamsCode([{key: 'a', reason: 'reserved', message: ''}]),
    'reserved_model_param',
  );
  assert.equal(
    invalidModelParamsCode([{key: 'a', reason: 'duplicate', message: ''}]),
    'duplicate_model_param',
  );
  assert.equal(
    invalidModelParamsCode([{key: 'a', reason: 'unknown', message: ''}]),
    'invalid_model_param',
  );
  assert.equal(
    invalidModelParamsCode([
      {key: 'a', reason: 'reserved', message: ''},
      {key: 'b', reason: 'unknown', message: ''},
    ]),
    'invalid_model_param',
  );
});

test('edit distance and its threshold', () => {
  assert.equal(editDistance('temprature', 'temperature'), 1);
  assert.equal(editDistance('tpo-k', 'top-k'), 2);
  assert.equal(editDistance('same', 'same'), 0);
  assert.equal(editDistance('', 'abc'), 3);

  // A short key gets a tight budget: `cc` must not become `c`... no, one edit is
  // allowed. But `cccc` is two edits from `c`, and that is too far to guess.
  assert.equal(suggestModelParamKey('cc', ['c', 'ctx-size']), 'c');
  assert.equal(suggestModelParamKey('cccc', ['c', 'ctx-size']), undefined);
  // A long key gets a looser one.
  assert.equal(suggestModelParamKey('repeat-penality', ACCEPTED), 'repeat-penalty');
});
