/**
 * Settings group slugs and the field keys clients act on.
 *
 * It holds names, never defaults -- a client asks the server what a setting is set to,
 * and renders the served schema for what it means.
 *
 * It is separate from `settings.ts` and zod-free. That split was once *required* (the web
 * bundle imported these and carried no zod); the bundle is gone, so it is now just a small
 * names-only module, which is a fine thing to be. Merging it would buy nothing.
 *
 * These names are a contract, the way `NELLE_ERROR_CODES` is.
 */

export const TITLES_SETTINGS_SLUG = 'titles';
export const ATTACHMENTS_SETTINGS_SLUG = 'attachments';
export const INSTRUCTIONS_SETTINGS_SLUG = 'instructions';
export const NETWORK_SETTINGS_SLUG = 'network';
export const REASONING_SETTINGS_SLUG = 'reasoning';
export const RUNTIME_SETTINGS_SLUG = 'runtime';
export const DISPLAY_SETTINGS_SLUG = 'display';

/**
 * Whether the server also binds a token-authenticated HTTPS listener for other
 * devices on the LAN. Off means localhost only. Takes effect on restart.
 */
export const ALLOW_LAN_ACCESS_KEY = 'allowLanAccess';

/** How long a paste has to be before it becomes a file. `0` disables. */
export const PASTE_TO_FILE_CHARACTERS_KEY = 'pasteToFileCharacters';

/** Appended to Nelle's operational system prompt, never replacing it. */
export const CUSTOM_INSTRUCTIONS_KEY = 'customInstructions';

/** Downscale an uploaded image above this many megapixels. `0` disables. */
export const MAX_IMAGE_MEGAPIXELS_KEY = 'maxImageMegapixels';

/**
 * The reasoning budgets, one field per level. They were a nested `{budgets: {...}}`
 * object in `state.json` with a hand-written route; the registry is flat, which is what
 * lets three number fields render themselves.
 */
export const REASONING_BUDGET_LOW_KEY = 'low';
export const REASONING_BUDGET_MEDIUM_KEY = 'medium';
export const REASONING_BUDGET_HIGH_KEY = 'high';

/** How llama.cpp is launched. Both take effect only when it is restarted. */
export const MODELS_MAX_KEY = 'modelsMax';
export const SLEEP_IDLE_SECONDS_KEY = 'sleepIdleSeconds';

/**
 * Saving one of these rebuilds Pi's cached sessions.
 *
 * Pi bakes the system prompt into a session at construction, so a change reaches
 * an open conversation only on its next turn -- and only if the session it would
 * reuse is thrown away first. Expect llama.cpp's KV cache to be invalidated too:
 * the next turn reprocesses the whole prompt.
 */
export const SESSION_RESETTING_SETTINGS_SLUGS: readonly string[] = [INSTRUCTIONS_SETTINGS_SLUG];
