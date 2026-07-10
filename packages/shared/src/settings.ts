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
 * `plans/nelle-thin-client-plan.md` Phase 0c, and it is why adding a setting
 * ships without a client release.
 *
 * Field keys are a contract, the way `NELLE_ERROR_CODES` is. Renaming one breaks
 * a client that stored it, and there is no migration path through a phone's
 * cache.
 */
import {z} from 'zod';

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
  | (SettingsFieldBase & {type: 'text' | 'textarea'; default: string; maxLength?: number})
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
 * Empty on purpose: this phase lands the machinery, and the phases after it are
 * each one entry here. The tests drive a fixture registry, so the machinery is
 * covered before it has a single real field.
 */
export const SETTINGS_REGISTRY: readonly SettingsGroup[] = [];

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
