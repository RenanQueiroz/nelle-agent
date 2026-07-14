/**
 * Server-owned settings: the registry, and the zod schemas built from it.
 *
 * A setting exists in exactly one place. The schema served by
 * `GET /api/settings/schema` and the validation `PATCH /api/settings/<slug>`
 * performs are both derived from `SETTINGS_REGISTRY`, so a field cannot be added
 * to one without the other -- there is no second copy to forget.
 *
 * Clients render the served schema. They do not import this module, and they
 * never carry a copy of a default: the server returns effective values. That is
 * the thin-client rule -- rendering and defaults stay server-side -- and it is
 * why adding a setting ships without a client release.
 *
 * Field keys are a contract, the way `NELLE_ERROR_CODES` is. Renaming one breaks
 * a client that stored it, and there is no migration path through a phone's
 * cache.
 */
import {z} from 'zod';

import {DEFAULT_TITLE_MAX_WORDS, DEFAULT_TITLE_PROMPT, TITLE_MAX_CHARACTERS} from './titles.ts';
import {
  ALLOW_LAN_ACCESS_KEY,
  ATTACHMENTS_SETTINGS_SLUG,
  CUSTOM_INSTRUCTIONS_KEY,
  INSTRUCTIONS_SETTINGS_SLUG,
  MAX_IMAGE_MEGAPIXELS_KEY,
  NETWORK_SETTINGS_SLUG,
  PASTE_TO_FILE_CHARACTERS_KEY,
  REASONING_BUDGET_HIGH_KEY,
  REASONING_BUDGET_LOW_KEY,
  REASONING_BUDGET_MEDIUM_KEY,
  DISPLAY_SETTINGS_SLUG,
  REASONING_SETTINGS_SLUG,
  MODELS_MAX_KEY,
  RUNTIME_SETTINGS_SLUG,
  SLEEP_IDLE_SECONDS_KEY,
  TITLES_SETTINGS_SLUG,
} from './settingsKeys.ts';
import {DEFAULT_DISPLAY_PREFERENCES, DISPLAY_PREFERENCE_FIELDS} from './displayPreferences.ts';
import {
  DEFAULT_REASONING_BUDGETS,
  MAX_REASONING_BUDGET,
  UNLIMITED_REASONING_BUDGET,
  type ReasoningBudgets,
} from './reasoning.ts';

export {ATTACHMENTS_SETTINGS_SLUG, INSTRUCTIONS_SETTINGS_SLUG, TITLES_SETTINGS_SLUG};

/**
 * Pi's own agent prompt already costs ~9,439 tokens of the context window, and a
 * long instruction block eats the reply budget. 8k characters is about 2k tokens.
 */
export const MAX_CUSTOM_INSTRUCTIONS_CHARACTERS = 8000;

/**
 * The registry's own shape, as zod -- so it can be *served* like every other
 * contract, and a client can codegen it instead of hand-parsing it.
 *
 * It was not served before, which is the one gap that made the served schema
 * pointless: the contract designed to be rendered generically was the only one a
 * client could not generate a type for. The Flutter client's first settings screen
 * hand-rolled a `NetworkSettingField` class to render a single toggle.
 *
 * The types below are `z.infer`red from these schemas rather than written twice,
 * so the served document and the registry cannot drift.
 */
export const settingsFieldTypeSchema = z.enum(['text', 'textarea', 'number', 'boolean', 'select']);

export type SettingsFieldType = z.infer<typeof settingsFieldTypeSchema>;

export const settingsSelectOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
});

export type SettingsSelectOption = z.infer<typeof settingsSelectOptionSchema>;

const settingsFieldBaseSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** One sentence, shown beneath the control. Says what the setting does. */
  help: z.string(),
});

/**
 * Discriminated on `type`, with one member per type -- including `text` and
 * `textarea` separately, even though they carry the same keys.
 *
 * `z.discriminatedUnion` needs a literal per member, and so does a Dart `sealed
 * class` switching on the wire `type`. One member per type maps to one variant,
 * which is what makes the client's `switch` exhaustive.
 */
export const settingsFieldSchema = z.discriminatedUnion('type', [
  settingsFieldBaseSchema.extend({
    type: z.literal('text'),
    default: z.string(),
    maxLength: z.number().int().positive().optional(),
    tokenCost: z.boolean().optional(),
  }),
  settingsFieldBaseSchema.extend({
    type: z.literal('textarea'),
    default: z.string(),
    maxLength: z.number().int().positive().optional(),
    /**
     * Render an estimated token cost beneath the control. A rendering hint the
     * server serves, so the client shows the cost without a round trip and
     * without knowing what the field means.
     */
    tokenCost: z.boolean().optional(),
  }),
  settingsFieldBaseSchema.extend({
    type: z.literal('number'),
    default: z.number(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    /** Rejects `2.5` where only whole numbers make sense, e.g. a word count. */
    integer: z.boolean().optional(),
  }),
  settingsFieldBaseSchema.extend({
    type: z.literal('boolean'),
    default: z.boolean(),
  }),
  settingsFieldBaseSchema.extend({
    type: z.literal('select'),
    default: z.string(),
    options: z.array(settingsSelectOptionSchema),
  }),
]);

export type SettingsField = z.infer<typeof settingsFieldSchema>;

/**
 * A group as the *schema* describes it. `GET /api/settings/schema` calls these
 * `sections`, because that is what a client renders.
 */
export const settingsSectionSchema = z.object({
  /** Both the `settings` table row key and the route segment. */
  slug: z.string(),
  title: z.string(),
  /** Shown once above the group's fields. */
  description: z.string().optional(),
  fields: z.array(settingsFieldSchema),
});

export type SettingsGroup = z.infer<typeof settingsSectionSchema>;

export const settingsSchemaResponseSchema = z.object({
  sections: z.array(settingsSectionSchema),
});

export type SettingsSchemaResponse = z.infer<typeof settingsSchemaResponseSchema>;

export type SettingsValue = string | number | boolean;
export type SettingsValues = Record<string, SettingsValue>;

/**
 * Above this many characters, a paste becomes a `.txt` attachment instead of
 * forty thousand characters in the input. `0` disables it.
 */
export const DEFAULT_PASTE_TO_FILE_CHARACTERS = 2500;

/**
 * llama.cpp holds one model by default, and that is deliberate: a fresh install on a
 * memory-constrained machine must not try to hold two. Multi-model use raises it.
 */
export const DEFAULT_MODELS_MAX = 1;
export const DEFAULT_SLEEP_IDLE_SECONDS = 90;

/**
 * `0` is not "unset". It means **no limit** -- the model stops thinking when it is done.
 * Asking for no thinking at all is what the level `off` is for.
 */
const BUDGET_HELP =
  `Tokens the model may spend thinking at this level. ${UNLIMITED_REASONING_BUDGET} means no limit -- ` +
  'the model stops when it is done.';

export const SETTINGS_REGISTRY: readonly SettingsGroup[] = [
  {
    slug: INSTRUCTIONS_SETTINGS_SLUG,
    title: 'Custom instructions',
    description:
      "Appended to Nelle's system prompt for every conversation. Saving it rebuilds open sessions, so the next turn reprocesses the whole prompt.",
    fields: [
      {
        key: CUSTOM_INSTRUCTIONS_KEY,
        label: 'Custom instructions',
        help: 'Tell the model who you are and how it should answer. Left empty, nothing is appended.',
        type: 'textarea',
        default: '',
        maxLength: MAX_CUSTOM_INSTRUCTIONS_CHARACTERS,
        tokenCost: true,
      },
    ],
  },
  {
    slug: ATTACHMENTS_SETTINGS_SLUG,
    title: 'Attachments',
    description: 'What happens to the things you paste and attach.',
    fields: [
      {
        key: PASTE_TO_FILE_CHARACTERS_KEY,
        label: 'Paste to file above',
        help: 'A paste longer than this many characters is attached as a text file. 0 keeps every paste in the message.',
        type: 'number',
        default: DEFAULT_PASTE_TO_FILE_CHARACTERS,
        min: 0,
        max: 100_000,
        step: 500,
        integer: true,
      },
      {
        key: MAX_IMAGE_MEGAPIXELS_KEY,
        label: 'Maximum image resolution',
        help: 'Downscale images above this many megapixels. 0 sends them untouched. This saves bytes and prompt-processing work, not context: how many tokens an image costs depends on the model, and gemma charges the same for six megapixels as for one.',
        type: 'number',
        // Off. On gemma it buys nothing in context, and a silent quality loss is
        // a bad default (the measurement is in AGENTS.md).
        default: 0,
        min: 0,
        max: 24,
        step: 0.5,
      },
    ],
  },
  {
    slug: TITLES_SETTINGS_SLUG,
    title: 'Conversation titles',
    description: 'How a new conversation earns its name after the first exchange.',
    fields: [
      {
        key: 'mode',
        label: 'Title source',
        help: 'Ask the model for a title, take the first line of your message, or keep "New chat".',
        type: 'select',
        // What Nelle does today. llama.cpp defaults its equivalent to off;
        // changing Nelle's behaviour by default would be a regression dressed as
        // a setting.
        default: 'llm',
        options: [
          {value: 'llm', label: 'Generated by the model'},
          {value: 'first-line', label: 'First line of your message'},
          {value: 'off', label: 'Off'},
        ],
      },
      {
        key: 'prompt',
        label: 'Title prompt',
        help: '{{USER}}, {{ASSISTANT}} and {{MAX_WORDS}} are substituted. Used only when the model writes the title.',
        type: 'textarea',
        default: DEFAULT_TITLE_PROMPT,
        maxLength: 4000,
      },
      {
        key: 'maxWords',
        label: 'Maximum words',
        help: `Titles are cut to this many words, and to ${TITLE_MAX_CHARACTERS} characters, whatever the model returns.`,
        type: 'number',
        default: DEFAULT_TITLE_MAX_WORDS,
        min: 1,
        max: 20,
        integer: true,
      },
    ],
  },
  {
    slug: REASONING_SETTINGS_SLUG,
    title: 'Reasoning budgets',
    description:
      "How long the model may think at each level. Nelle's `max` sends no budget at all and `off` " +
      'asks for no thinking, so neither has a number here. A spent budget forces the thinking ' +
      'block closed mid-thought, and llama.cpp hands the model its own end tag.',
    fields: [
      {
        key: REASONING_BUDGET_LOW_KEY,
        label: 'Low',
        help: BUDGET_HELP,
        type: 'number',
        default: DEFAULT_REASONING_BUDGETS.low,
        min: 0,
        max: MAX_REASONING_BUDGET,
        integer: true,
      },
      {
        key: REASONING_BUDGET_MEDIUM_KEY,
        label: 'Medium',
        help: BUDGET_HELP,
        type: 'number',
        default: DEFAULT_REASONING_BUDGETS.medium,
        min: 0,
        max: MAX_REASONING_BUDGET,
        integer: true,
      },
      {
        key: REASONING_BUDGET_HIGH_KEY,
        label: 'High',
        help: BUDGET_HELP,
        type: 'number',
        default: DEFAULT_REASONING_BUDGETS.high,
        min: 0,
        max: MAX_REASONING_BUDGET,
        integer: true,
      },
    ],
  },
  {
    slug: DISPLAY_SETTINGS_SLUG,
    title: 'Display',
    description: 'What a conversation shows you. These follow you to every device.',
    // Generated from the fields that already existed: `DISPLAY_PREFERENCE_FIELDS` carried
    // a key, a label and help text for each toggle, which is a registry in all but name.
    // Moving them here is deletion, not duplication.
    fields: DISPLAY_PREFERENCE_FIELDS.map(field => ({
      key: field.key,
      label: field.label,
      help: field.help,
      type: 'boolean' as const,
      default: DEFAULT_DISPLAY_PREFERENCES[field.key],
    })),
  },
  {
    slug: RUNTIME_SETTINGS_SLUG,
    title: 'Runtime',
    description:
      'How llama.cpp is launched. Both take effect when it next starts -- changing them while ' +
      'it is running does nothing until you restart it.',
    fields: [
      {
        key: MODELS_MAX_KEY,
        label: 'Models kept loaded',
        help:
          'How many models llama.cpp may hold in memory at once. The default is 1 on purpose: a ' +
          'fresh install on a small machine must not try to hold two. Raise it to run two chats ' +
          'on two models at the same time. Takes effect after a llama.cpp restart.',
        type: 'number',
        default: DEFAULT_MODELS_MAX,
        min: 1,
        max: 16,
        integer: true,
      },
      {
        key: SLEEP_IDLE_SECONDS_KEY,
        label: 'Sleep an idle model after',
        help:
          'Seconds of inactivity before llama.cpp puts a model to sleep and frees its memory. It ' +
          'wakes on the next message, which costs a moment. 0 never sleeps. Takes effect after a ' +
          'llama.cpp restart.',
        type: 'number',
        default: DEFAULT_SLEEP_IDLE_SECONDS,
        min: 0,
        max: 86_400,
        integer: true,
      },
    ],
  },
  {
    slug: NETWORK_SETTINGS_SLUG,
    title: 'Remote access',
    description:
      'Let other devices on your network reach this server over authenticated HTTPS. Off by default -- the server binds to localhost only.',
    fields: [
      {
        key: ALLOW_LAN_ACCESS_KEY,
        label: 'Allow LAN devices',
        help: 'Bind an HTTPS listener that paired devices on your network can reach. Takes effect after a server restart.',
        type: 'boolean',
        default: false,
      },
    ],
  },
];

export function findSettingsGroup(
  slug: string,
  registry: readonly SettingsGroup[] = SETTINGS_REGISTRY,
): SettingsGroup | undefined {
  return registry.find(group => group.slug === slug);
}

export function settingsGroupDefaults(group: SettingsGroup): SettingsValues {
  const defaults: SettingsValues = {};
  for (const field of group.fields) {
    defaults[field.key] = field.default;
  }
  return defaults;
}

/**
 * The validator for one field's **value**, bounds and all. Its own `default` must
 * satisfy it.
 *
 * Not to be confused with `settingsFieldSchema`, which describes the field's
 * *definition* and is what `GET /api/settings/schema` serves.
 */
export function settingsValueSchema(field: SettingsField): z.ZodType<SettingsValue> {
  switch (field.type) {
    case 'text':
    case 'textarea': {
      let schema = z.string();
      if (field.maxLength !== undefined) {
        schema = schema.max(field.maxLength, {
          message: `${field.label} is limited to ${field.maxLength.toLocaleString('en-US')} characters.`,
        });
      }
      return schema;
    }
    case 'number': {
      let schema = field.integer ? z.number().int() : z.number().finite();
      if (field.min !== undefined) {
        schema = schema.min(field.min);
      }
      if (field.max !== undefined) {
        schema = schema.max(field.max);
      }
      return schema;
    }
    case 'boolean':
      return z.boolean();
    case 'select':
      return z.enum(field.options.map(option => option.value) as [string, ...string[]]);
    default: {
      // TypeScript already refuses a field type this switch does not handle -- adding one
      // to `settingsFieldSchema` without adding it here is a compile error, which is the
      // guard that matters. This is the message if it ever slips through anyway (a
      // hand-built registry in a test, say): a *named* failure beats
      // `undefined is not an object (evaluating 'settingsValueSchema(field).safeParse')`,
      // which is what the client was shown when it did.
      const unhandled: never = field;
      throw new Error(
        `Unhandled settings field type: ${JSON.stringify((unhandled as SettingsField).type)}`,
      );
    }
  }
}

/** Every field, required. What `GET /api/settings/<slug>` answers with. */
export function settingsGroupSchema(group: SettingsGroup) {
  const shape: Record<string, z.ZodType<SettingsValue>> = {};
  for (const field of group.fields) {
    shape[field.key] = settingsValueSchema(field);
  }
  return z.object(shape);
}

/**
 * What `PATCH` accepts: any subset of the group's fields, and nothing else.
 *
 * `.strict()` is the point. A key absent from the registry is a typo or a client
 * talking to an older server, and both deserve to be told which key it was
 * rather than having it silently dropped.
 */
export function settingsPatchSchema(group: SettingsGroup) {
  return settingsGroupSchema(group).partial().strict();
}

/**
 * Reads a stored row into effective values, field by field.
 *
 * A value that no longer parses -- a bound tightened, a select option removed, a
 * row written by a newer server -- falls back to that field's default. Settings
 * are not worth failing a request over, and one bad field must not take the
 * group's other nine with it.
 */
export function coerceSettingsValues(group: SettingsGroup, stored: unknown): SettingsValues {
  const values = settingsGroupDefaults(group);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return values;
  }
  const record = stored as Record<string, unknown>;
  for (const field of group.fields) {
    const parsed = settingsValueSchema(field).safeParse(record[field.key]);
    if (parsed.success) {
      values[field.key] = parsed.data;
    }
  }
  return values;
}

/**
 * The reasoning budgets, read out of the `reasoning` settings group.
 *
 * They used to live in `state.json` behind a hand-written route. Reading them here means
 * `piHarness` and the settings screen see the same value, and the group renders itself
 * from the schema like every other.
 *
 * Coerced field by field: one unreadable value falls back to its own default and takes no
 * sibling with it -- the same rule the settings reads already follow.
 */
export function reasoningBudgetsFromSettings(values: SettingsValues): ReasoningBudgets {
  const read = (key: string, fallback: number): number => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : fallback;
  };
  return {
    low: read(REASONING_BUDGET_LOW_KEY, DEFAULT_REASONING_BUDGETS.low),
    medium: read(REASONING_BUDGET_MEDIUM_KEY, DEFAULT_REASONING_BUDGETS.medium),
    high: read(REASONING_BUDGET_HIGH_KEY, DEFAULT_REASONING_BUDGETS.high),
  };
}

/** How llama.cpp is launched, read out of the `runtime` settings group. */
export type RuntimeLimits = {
  modelsMax: number;
  sleepIdleSeconds: number;
};

export function runtimeLimitsFromSettings(values: SettingsValues): RuntimeLimits {
  const read = (key: string, fallback: number, min: number): number => {
    const value = values[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min
      ? Math.trunc(value)
      : fallback;
  };
  return {
    modelsMax: read(MODELS_MAX_KEY, DEFAULT_MODELS_MAX, 1),
    sleepIdleSeconds: read(SLEEP_IDLE_SECONDS_KEY, DEFAULT_SLEEP_IDLE_SECONDS, 0),
  };
}
