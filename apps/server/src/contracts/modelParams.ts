/**
 * llama.cpp's option catalogue, and what makes a `models.ini` key valid.
 *
 * An unknown key in a preset is *fatal*: llama-server refuses to start with
 * `option '...' not recognized in preset '...'`, and Nelle's runtime never comes
 * up. A bad *value* is milder -- the option's callback does not run until the
 * model instance is spawned -- so this validates keys and never guesses at
 * values. Guessing types from a `--help` value hint would be a second, worse
 * copy of llama.cpp's parser, and it would reject values llama.cpp accepts.
 *
 * Zod-free, so a client can offer completion and near-miss suggestions without a
 * round trip.
 */

export type LlamaOption = {
  /** Every argument spelling, dashes stripped: `['c', 'ctx-size']`. */
  keys: string[];
  /** Environment variable names, which a preset accepts as keys too. */
  env: string[];
  /** `N`, `<0|1>`, `START END`. Absent for a flag such as `--swa-full`. */
  valueHint?: string;
  help: string;
  section: string;
};

export type LlamaOptionCatalogue = {
  /**
   * `false` when no binary is installed, or `--help` would not run. The
   * unknown-key check is then skipped: refusing to save a parameter because
   * Nelle could not run a binary would be worse than the typo.
   */
  available: boolean;
  options: LlamaOption[];
};

export type InvalidModelParamReason =
  | 'unknown'
  | 'reserved'
  | 'duplicate'
  | 'syntax'
  | 'out_of_range';

export type InvalidModelParam = {
  key: string;
  reason: InvalidModelParamReason;
  message: string;
  /** The nearest real key, when one is close enough to be worth offering. */
  suggestion?: string;
};

/** A param Nelle will save, but which the user probably did not mean. */
export type ModelParamWarning = {
  key: string;
  message: string;
};

/**
 * Every spelling of `--ctx-size`, because they are one option and a guard that knows only
 * one of them is a guard you step around by accident. llama.cpp's own accept-set is the
 * union of each argument spelling with its leading dashes stripped, plus the env var name
 * (`common/preset.cpp`, `get_map_key_opt`), so all three of these reach the same field.
 *
 * **Case-sensitive**, like the catalogue: `-c` is `--ctx-size` and `-C` is `--cpu-mask`.
 */
export const CONTEXT_SIZE_KEYS: ReadonlySet<string> = new Set([
  'c',
  'ctx-size',
  'LLAMA_ARG_CTX_SIZE',
]);

/**
 * How far past its trained window a model may be stretched before Nelle calls it a typo.
 *
 * Running above `n_ctx_train` is **legitimate and sometimes recommended**: RoPE/YaRN
 * rescaling extends a model's context, llama.cpp ships the flags for it
 * (`--rope-scaling {none,linear,yarn}`, `--yarn-orig-ctx`), and Qwen's own model cards tell
 * you to do exactly that. llama.cpp permits it with nothing but a warning
 * (`llama-context.cpp`: `n_ctx_seq (%u) > n_ctx_train (%u) -- possible training context
 * overflow`), and Nelle mirrors that: **any** overshoot warns, and none is refused.
 *
 * But the real band is 2x-8x. Nobody has ever had a reason to ask for 6,866x, which is what
 * an extra few zeros gets you -- and `c` is the one lever that *bypasses* `--fit` (which
 * only adjusts arguments the user left unset), so llama.cpp allocates a KV cache for
 * whatever number it is handed, without ever consulting how much memory exists. A fat
 * finger here does not fail the load: it takes the machine down. (Measured, on this
 * repository, with `c = 900000000`: llama-server logged `loading model` and the host died
 * mid-allocation -- no error, no exit code, nothing to report afterwards.)
 *
 * 32x therefore sits an order of magnitude above any real extension and three below the
 * typo. It refuses nothing anyone has ever wanted.
 */
export const MAX_CONTEXT_EXTENSION_FACTOR = 32;

/**
 * The context size a params draft asks for, or `null` when it does not ask for one.
 *
 * `0` is not a size and is deliberately excluded: `common/arg.cpp` reads it as "the user
 * explicitly wants the full trained window" and disables fit reduction, so it can never
 * overshoot. A value that is not a positive integer is llama.cpp's to reject, not Nelle's
 * to guess at.
 */
function requestedContextSize(params: Record<string, string>): {key: string; size: number} | null {
  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim();
    if (!CONTEXT_SIZE_KEYS.has(key)) {
      continue;
    }
    const size = Number(rawValue.trim());
    if (!Number.isInteger(size) || size <= 0) {
      return null;
    }
    return {key, size};
  }
  return null;
}

const count = (value: number): string => value.toLocaleString('en-US');

/**
 * A context size Nelle will save but which is past the model's trained window.
 *
 * Separate from `validateModelParams` because it is not an error: the save lands, and the
 * user is told what they just asked for. `trainedWindow` is `null` for a model llama.cpp has
 * never loaded -- Nelle has no window to compare against, so it says nothing.
 */
export function modelParamWarnings(
  params: Record<string, string>,
  trainedWindow: number | null | undefined,
): ModelParamWarning[] {
  const requested = requestedContextSize(params);
  if (!requested || !trainedWindow || requested.size <= trainedWindow) {
    return [];
  }
  if (requested.size > trainedWindow * MAX_CONTEXT_EXTENSION_FACTOR) {
    // Refused outright by `validateModelParams`; warning about it too would be noise.
    return [];
  }
  const factor = requested.size / trainedWindow;
  return [
    {
      key: requested.key,
      message:
        `${count(requested.size)} is ${factor.toFixed(factor < 10 ? 1 : 0)}x this model's ` +
        `trained window (${count(trainedWindow)}). That works only with RoPE or YaRN ` +
        'scaling — set `rope-scaling` and `yarn-orig-ctx` too, or the model will produce ' +
        'nonsense past the window it was trained on.',
    },
  ];
}

/** The sampling keys people actually reach for, for the Models section's hint. */
export const COMMON_SAMPLING_KEYS = [
  'temp',
  'top-k',
  'top-p',
  'min-p',
  'seed',
  'repeat-penalty',
] as const;

/**
 * Preset keys `--help` does not print, and cannot.
 *
 * `common_params_add_preset_options` (`common/arg.cpp`) registers these with
 * `.set_preset_only()`, so they never reach the CLI's usage text -- but
 * `get_map_key_opt` builds its map from the same option list, so a preset
 * accepts them. A catalogue read from `--help` alone would therefore reject a
 * key llama-server itself is perfectly happy with, and the user would be told
 * their valid parameter is a typo.
 *
 * Nelle writes neither of them. `stop-timeout` used to be stamped into every
 * model section at `10`, which is *exactly* llama.cpp's own default
 * (`DEFAULT_STOP_TIMEOUT`, `tools/server/server-models.cpp`) -- so it bought
 * nothing and cost a mystery row in every model's parameter editor, plus a rule
 * saying it was the one key a full replacement could not delete. Writing a
 * default back to its owner is never worth that.
 *
 * This is the one place a copy of llama.cpp's argument list is unavoidable.
 * Keep it as short as llama.cpp keeps its preset-only list.
 */
export const PRESET_ONLY_KEYS: readonly LlamaOption[] = [
  {
    keys: ['load-on-startup'],
    env: ['__PRESET_LOAD_ON_STARTUP'],
    valueHint: 'NAME',
    help: 'in server router mode, autoload this model on startup',
    section: 'preset',
  },
  {
    keys: ['stop-timeout'],
    env: ['__PRESET_STOP_TIMEOUT'],
    valueHint: 'SECONDS',
    help: 'in server router mode, force-kill model instance after this many seconds of graceful shutdown',
    section: 'preset',
  },
];

const SECTION_HEADER = /^-{3,}\s*(.+?)\s*-{3,}$/;
const ENV_NAME = /\(env:\s*([A-Z0-9_,\s]+)\)/g;

/**
 * Parses `llama-server --help`.
 *
 * An entry starts at column 0 with a dash. Spellings are comma-separated; what
 * follows the last one, up to the description's column, is the value hint. The
 * description and its `(env: NAME)` arrive on the same line or on continuation
 * lines indented to the description column -- and when the spellings are long
 * enough to reach that column, on continuation lines only.
 */
export function parseLlamaOptionCatalogue(helpText: string): LlamaOption[] {
  const options: LlamaOption[] = [];
  let section = 'common';
  let current: {option: LlamaOption; description: string[]} | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const description = current.description.join(' ');
    current.option.env = readEnvNames(description);
    current.option.help = cleanHelp(description);
    options.push(current.option);
    current = null;
  };

  for (const line of helpText.split(/\r?\n/)) {
    const header = SECTION_HEADER.exec(line.trim());
    if (header) {
      flush();
      section = header[1]!.replace(/\s*params\s*$/i, '').trim() || header[1]!;
      continue;
    }
    if (!line.startsWith('-')) {
      // A continuation line, or a blank one between entries.
      if (current && line.trim()) {
        current.description.push(line.trim());
      }
      continue;
    }

    flush();
    const parsed = parseOptionLine(line);
    if (!parsed) {
      continue;
    }
    current = {
      option: {keys: parsed.keys, env: [], valueHint: parsed.valueHint, help: '', section},
      description: parsed.description ? [parsed.description] : [],
    };
  }
  flush();
  return options;
}

const SPELLING = /^\s*(--?[A-Za-z0-9][^\s,]*)(,)?/;

function parseOptionLine(line: string): {
  keys: string[];
  valueHint?: string;
  description?: string;
} | null {
  const keys: string[] = [];
  let rest = line;
  for (;;) {
    const match = SPELLING.exec(rest);
    if (!match) {
      break;
    }
    keys.push(match[1]!.replace(/^-+/, ''));
    rest = rest.slice(match[0].length);
    // No trailing comma means that was the last spelling.
    if (!match[2]) {
      break;
    }
  }
  if (keys.length === 0) {
    return null;
  }

  // The description begins at the first run of two spaces. What lies between the
  // last spelling and it is the value hint, which may itself contain single
  // spaces: `--override-tensor <tensor name pattern>=<buffer type>,...`.
  const gap = / {2,}/.exec(rest);
  if (!gap) {
    return {keys, valueHint: rest.trim() || undefined};
  }
  return {
    keys,
    valueHint: rest.slice(0, gap.index).trim() || undefined,
    description: rest.slice(gap.index).trim() || undefined,
  };
}

function readEnvNames(description: string): string[] {
  const names: string[] = [];
  for (const match of description.matchAll(ENV_NAME)) {
    for (const name of match[1]!.split(',')) {
      const trimmed = name.trim();
      if (trimmed) {
        names.push(trimmed);
      }
    }
  }
  return names;
}

function cleanHelp(description: string): string {
  return description.replace(ENV_NAME, '').replace(/\s+/g, ' ').trim();
}

/**
 * The catalogue a preset is validated against: what `--help` printed, plus the
 * preset-only keys it cannot print.
 *
 * Help text that parsed to nothing is a format Nelle does not understand -- a
 * binary too old, or too new. Reporting it as `available` with only the
 * preset-only keys would reject every real option the user typed, so it is
 * reported as unavailable and the unknown-key check is skipped.
 */
export function llamaOptionCatalogue(helpText: string): LlamaOptionCatalogue {
  const parsed = parseLlamaOptionCatalogue(helpText);
  if (parsed.length === 0) {
    return {available: false, options: []};
  }
  return {available: true, options: [...PRESET_ONLY_KEYS, ...parsed]};
}

/**
 * Every key a preset accepts: each spelling with its dashes stripped, and each
 * environment variable name. `common/preset.cpp`'s `get_map_key_opt` builds the
 * same union, which is why a validator that only knew `ctx-size` would reject
 * Nelle's own `models.ini`.
 *
 * Case-sensitive, and it has to be: `-c` is `--ctx-size` and `-C` is
 * `--cpu-mask`.
 */
export function acceptedModelParamKeys(options: LlamaOption[]): Set<string> {
  const keys = new Set<string>();
  for (const option of options) {
    for (const key of option.keys) {
      keys.add(key);
    }
    for (const name of option.env) {
      keys.add(name);
    }
  }
  return keys;
}

/** Unweighted Levenshtein. Small alphabets, short strings; no need for more. */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  let previous = Array.from({length: b.length + 1}, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * The nearest accepted key, or `undefined` when nothing is close enough to be
 * worth offering. A suggestion the user did not mean is worse than none.
 */
export function suggestModelParamKey(key: string, accepted: Iterable<string>): string | undefined {
  const limit = key.length <= 4 ? 1 : key.length <= 8 ? 2 : 3;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of accepted) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance || (distance === bestDistance && candidate < best!)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

/**
 * Every problem with a params draft, not just the first.
 *
 * A form with three typos should light up three rows on one save, not on three.
 * `acceptedKeys` absent means the catalogue is unavailable; syntax, reserved
 * keys and duplicates are still enforced.
 */
export function validateModelParams(
  params: Record<string, string>,
  options: {
    reservedKeys?: Set<string>;
    acceptedKeys?: Set<string>;
    /**
     * The model's trained context window, from `model_cache.context_train` -- which llama.cpp
     * reports once it has loaded the model. `null`/absent for one it never has, and the
     * ceiling is then not enforced: Nelle has nothing to measure the request against, and
     * inventing a bound would refuse a legitimate long-context model on its first load.
     */
    trainedContextWindow?: number | null;
  } = {},
): InvalidModelParam[] {
  const reserved = options.reservedKeys ?? new Set<string>();
  const invalid: InvalidModelParam[] = [];
  const seen = new Set<string>();

  // The one *value* Nelle checks, and it is not a memory estimate -- it is one integer against
  // a number llama.cpp itself reported. See `MAX_CONTEXT_EXTENSION_FACTOR` for why this is the
  // exception to "Nelle does not police how a model is loaded".
  const requested = requestedContextSize(params);
  const trainedWindow = options.trainedContextWindow;
  if (requested && trainedWindow && requested.size > trainedWindow * MAX_CONTEXT_EXTENSION_FACTOR) {
    const ceiling = trainedWindow * MAX_CONTEXT_EXTENSION_FACTOR;
    invalid.push({
      key: requested.key,
      reason: 'out_of_range',
      message:
        `${count(requested.size)} is ${Math.round(requested.size / trainedWindow).toLocaleString('en-US')}x ` +
        `this model's trained window (${count(trainedWindow)}). llama.cpp would try to ` +
        `allocate a KV cache for it and take the machine down. The largest supported ` +
        `extension is ${MAX_CONTEXT_EXTENSION_FACTOR}x (${count(ceiling)}).`,
      suggestion: String(ceiling),
    });
  }

  for (const [rawKey, rawValue] of Object.entries(params)) {
    const key = rawKey.trim();
    if (!key) {
      invalid.push({key: rawKey, reason: 'syntax', message: 'Parameter keys cannot be empty.'});
      continue;
    }
    if (/[[\]=\r\n]/.test(key)) {
      invalid.push({
        key,
        reason: 'syntax',
        message: `"${key}" cannot contain brackets, equals signs, or newlines.`,
      });
      continue;
    }
    if (reserved.has(key.toLowerCase())) {
      invalid.push({
        key,
        reason: 'reserved',
        message: `Set "${key}" through the dedicated model field instead of params.`,
      });
      continue;
    }
    // Trimmed, not lowercased: a JSON object cannot hold the same key twice, so
    // this catches ` c` beside `c`. Lowercasing would call `c` and `C` the same
    // key, and they are `--ctx-size` and `--cpu-mask`.
    if (seen.has(key)) {
      invalid.push({key, reason: 'duplicate', message: `Duplicate parameter key: ${key}`});
      continue;
    }
    seen.add(key);
    if (/[\r\n]/.test(rawValue)) {
      invalid.push({
        key,
        reason: 'syntax',
        message: `"${key}" cannot contain newline characters.`,
      });
      continue;
    }
    if (options.acceptedKeys && options.acceptedKeys.size > 0 && !options.acceptedKeys.has(key)) {
      invalid.push({
        key,
        reason: 'unknown',
        message: `"${key}" is not a llama.cpp option. llama-server would refuse to start.`,
        suggestion: suggestModelParamKey(key, options.acceptedKeys),
      });
    }
  }
  return invalid;
}

/** One sentence for a client that reads only the top-level error `code`. */
export function invalidModelParamsMessage(invalid: InvalidModelParam[]): string {
  if (invalid.length === 1) {
    return invalid[0]!.message;
  }
  return `${invalid.length} parameters are not valid.`;
}

/**
 * The single top-level `code`, chosen from the reasons present. A client that
 * branches on `invalidParams[].reason` never needs it; one that reads only
 * `error.code` still gets the old behaviour.
 */
export function invalidModelParamsCode(invalid: InvalidModelParam[]): string {
  const reasons = new Set(invalid.map(entry => entry.reason));
  if (reasons.size === 1) {
    if (reasons.has('reserved')) {
      return 'reserved_model_param';
    }
    if (reasons.has('duplicate')) {
      return 'duplicate_model_param';
    }
  }
  return 'invalid_model_param';
}
