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
export const INSTRUCTIONS_SETTINGS_SLUG = 'instructions';

/** How long a paste has to be before it becomes a file. `0` disables. */
export const PASTE_TO_FILE_CHARACTERS_KEY = 'pasteToFileCharacters';

/** Appended to Nelle's operational system prompt, never replacing it. */
export const CUSTOM_INSTRUCTIONS_KEY = 'customInstructions';

/** Downscale an uploaded image above this many megapixels. `0` disables. */
export const MAX_IMAGE_MEGAPIXELS_KEY = 'maxImageMegapixels';

/**
 * Saving one of these rebuilds Pi's cached sessions.
 *
 * Pi bakes the system prompt into a session at construction, so a change reaches
 * an open conversation only on its next turn -- and only if the session it would
 * reuse is thrown away first. Expect llama.cpp's KV cache to be invalidated too:
 * the next turn reprocesses the whole prompt.
 */
export const SESSION_RESETTING_SETTINGS_SLUGS: readonly string[] = [INSTRUCTIONS_SETTINGS_SLUG];
