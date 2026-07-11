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
  TITLES_SETTINGS_SLUG,
} from './settingsKeys.ts';

export {ATTACHMENTS_SETTINGS_SLUG, INSTRUCTIONS_SETTINGS_SLUG, TITLES_SETTINGS_SLUG};

/**
 * Pi's own agent prompt already costs ~9,439 tokens of the context window, and a
 * long instruction block eats the reply budget. 8k characters is about 2k tokens.
 */
export const MAX_CUSTOM_INSTRUCTIONS_CHARACTERS = 8000;

export type SettingsFieldType = 'text' | 'textarea' | 'number' | 'boolean' | 'select';

export type SettingsSelectOption = {
  value: string;
  label: string;
};

type SettingsFieldBase = {
  key: string;
  label: string;
  /** One sentence, shown beneath the control. Says what the setting does. */
  help: string;
};

export type SettingsField =
  | (SettingsFieldBase & {
      type: 'text' | 'textarea';
      default: string;
      maxLength?: number;
      /**
       * Render an estimated token cost beneath the control. A rendering hint the
       * server serves, so the client shows the cost without a round trip and
       * without knowing what the field means.
       */
      tokenCost?: boolean;
    })
  | (SettingsFieldBase & {
      type: 'number';
      default: number;
      min?: number;
      max?: number;
      step?: number;
      /** Rejects `2.5` where only whole numbers make sense, e.g. a word count. */
      integer?: boolean;
    })
  | (SettingsFieldBase & {type: 'boolean'; default: boolean})
  | (SettingsFieldBase & {
      type: 'select';
      default: string;
      options: readonly SettingsSelectOption[];
    });

export type SettingsGroup = {
  /** Both the `settings` table row key and the route segment. */
  slug: string;
  title: string;
  /** Shown once above the group's fields. */
  description?: string;
  fields: readonly SettingsField[];
};

export type SettingsValue = string | number | boolean;
export type SettingsValues = Record<string, SettingsValue>;

/**
 * Above this many characters, a paste becomes a `.txt` attachment instead of
 * forty thousand characters in the input. `0` disables it.
 */
export const DEFAULT_PASTE_TO_FILE_CHARACTERS = 2500;

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

/** The schema for one field, bounds and all. Its own `default` must satisfy it. */
export function settingsFieldSchema(field: SettingsField): z.ZodType<SettingsValue> {
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
  }
}

/** Every field, required. What `GET /api/settings/<slug>` answers with. */
export function settingsGroupSchema(group: SettingsGroup) {
  const shape: Record<string, z.ZodType<SettingsValue>> = {};
  for (const field of group.fields) {
    shape[field.key] = settingsFieldSchema(field);
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
    const parsed = settingsFieldSchema(field).safeParse(record[field.key]);
    if (parsed.success) {
      values[field.key] = parsed.data;
    }
  }
  return values;
}

/** The payload of `GET /api/settings/schema`. */
export type SettingsSchemaResponse = {
  sections: readonly SettingsGroup[];
};
