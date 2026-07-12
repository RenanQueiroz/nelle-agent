/// Slash commands, ported from `packages/shared/src/commands.ts`.
///
/// **`/compact` is not refused by the chat route.** It is on the server's allowlist, so
/// `assertSupportedSlashCommand` lets it through — and nothing downstream interprets it,
/// which means posting it to `chat/stream` sends it to the model as the literal text
/// "/compact". Routing it to `compact/stream` is entirely the client's job.
library;

const compactCommand = '/compact';

/// `"/compact be brief"` -> `"be brief"`; `"/compact"` -> `""`; anything else -> null.
///
/// Case-sensitive and prefix-exact, matching the server's `parseCompactCommand`.
String? parseCompactCommand(String value) {
  if (value == compactCommand) {
    return '';
  }
  if (value.startsWith('$compactCommand ')) {
    return value.substring(compactCommand.length + 1).trim();
  }
  return null;
}

/// `"/Compact do it"` -> `"/compact"`. Null for an ordinary prompt.
String? parseSlashCommandName(String value) {
  final match = RegExp(r'^/[^\s]+').firstMatch(value.trim());
  return match?.group(0)?.toLowerCase();
}
