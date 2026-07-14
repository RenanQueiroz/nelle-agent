/**
 * The slash-command allowlist, and the guidance for everything Pi offers that
 * Nelle deliberately routes through its own UI instead.
 *
 * The server serves this over `GET /api/commands`, so allowlisting a new command
 * ships without touching a client. Zod-free: the web bundle imports it directly.
 */

export type SlashCommand = {
  name: string;
  /** Shown after the name in a typeahead, e.g. `/compact [instructions]`. */
  argHint?: string;
  description: string;
};

export type UnsupportedSlashCommand = {
  name: string;
  /** Where the user should go instead. */
  guidance: string;
};

export const COMPACT_COMMAND = '/compact';

export const SUPPORTED_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: COMPACT_COMMAND,
    argHint: '[instructions]',
    description: 'Compact this conversation context',
  },
];

/**
 * Pi commands Nelle answers with a pointer rather than a prompt. Sending any of
 * these to Pi as literal text would be worse than refusing them.
 */
export const UNSUPPORTED_SLASH_COMMANDS: readonly UnsupportedSlashCommand[] = [
  {name: '/new', guidance: 'Use the New chat button in the conversation sidebar.'},
  {name: '/resume', guidance: 'Use the conversation sidebar and search to resume a chat.'},
  {name: '/model', guidance: 'Use the model selector in the composer or assistant footer.'},
  {name: '/scoped-models', guidance: 'Use Nelle model selectors and Settings instead.'},
  {name: '/login', guidance: 'Nelle manages the local llama.cpp provider through Settings.'},
  {name: '/logout', guidance: 'Nelle manages the local llama.cpp provider through Settings.'},
  {name: '/settings', guidance: 'Use the Settings controls in the sidebar.'},
  {name: '/fork', guidance: 'Use message and conversation menus for fork actions.'},
  {name: '/clone', guidance: 'Use the conversation menu duplicate action.'},
  {name: '/name', guidance: 'Use the conversation row rename action.'},
  {name: '/session', guidance: 'Use the conversation sidebar.'},
  {name: '/tree', guidance: 'Nelle does not expose the full Pi tree explorer in v1.'},
  {name: '/export', guidance: 'Use the conversation export action when it is available.'},
  {name: '/import', guidance: 'Use the conversation import action when it is available.'},
  {name: '/share', guidance: 'Sharing is not exposed in this local-first version yet.'},
  {name: '/copy', guidance: 'Use assistant message copy buttons.'},
  {name: '/trust', guidance: 'Host tool trust is managed by Nelle settings.'},
  {name: '/reload', guidance: 'Use the runtime and router refresh controls.'},
  {name: '/hotkeys', guidance: 'Keyboard help is not exposed in the chat composer yet.'},
  {name: '/changelog', guidance: 'Release notes are not exposed in the chat composer.'},
  {name: '/quit', guidance: 'Stop the server from the host process or runtime controls.'},
];

export type SlashCommandRegistry = {
  commands: readonly SlashCommand[];
  unsupported: readonly UnsupportedSlashCommand[];
};

export const SLASH_COMMAND_REGISTRY: SlashCommandRegistry = {
  commands: SUPPORTED_SLASH_COMMANDS,
  unsupported: UNSUPPORTED_SLASH_COMMANDS,
};

/** `"/Compact do it"` -> `"/compact"`. Returns `null` for ordinary prompts. */
export function parseSlashCommandName(value: string): string | null {
  const match = value.trim().match(/^\/[^\s]+/);
  return match?.[0]?.toLowerCase() ?? null;
}

export function isSupportedSlashCommand(
  name: string,
  registry: SlashCommandRegistry = SLASH_COMMAND_REGISTRY,
): boolean {
  return registry.commands.some(command => command.name === name);
}

/**
 * The refusal a user sees for a command Nelle will not forward. `null` means the
 * text is a prompt, or a command the server allows.
 */
export function unsupportedSlashCommandMessage(
  value: string,
  registry: SlashCommandRegistry = SLASH_COMMAND_REGISTRY,
): string | null {
  const command = parseSlashCommandName(value);
  if (!command || isSupportedSlashCommand(command, registry)) {
    return null;
  }
  const known = registry.unsupported.find(entry => entry.name === command);
  if (known) {
    return `${command} is handled by Nelle UI. ${known.guidance}`;
  }
  const supported = registry.commands.map(entry => entry.name).join(', ');
  return supported
    ? `${command} is not supported in Nelle chat. Supported commands: ${supported}.`
    : `${command} is not supported in Nelle chat.`;
}

/** `"/compact be brief"` -> `"be brief"`; `"/compact"` -> `""`; otherwise `null`. */
export function parseCompactCommand(value: string): string | null {
  if (value === COMPACT_COMMAND) {
    return '';
  }
  if (value.startsWith(`${COMPACT_COMMAND} `)) {
    return value.slice(COMPACT_COMMAND.length + 1).trim();
  }
  return null;
}
