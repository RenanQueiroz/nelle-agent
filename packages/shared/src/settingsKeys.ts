/**
 * Settings group slugs and the field keys clients act on.
 *
 * Zod-free, and separate from `settings.ts` for exactly one reason: the web
 * bundle imports these and carries no zod. It holds names, never defaults --
 * a client asks the server what a setting is set to, and renders the served
 * schema for what it means.
 *
 * These names are a contract, the way `NELLE_ERROR_CODES` is.
 */

export const TITLES_SETTINGS_SLUG = 'titles';
export const ATTACHMENTS_SETTINGS_SLUG = 'attachments';

/** How long a paste has to be before it becomes a file. `0` disables. */
export const PASTE_TO_FILE_CHARACTERS_KEY = 'pasteToFileCharacters';
