import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// Slash commands, ported from `packages/shared/src/commands.ts`.
///
/// **`/compact` is not refused by the chat route.** It is on the server's allowlist, so
/// `assertSupportedSlashCommand` lets it through — and nothing downstream interprets it,
/// which means posting it to `chat/stream` sends it to the model as the literal text
/// "/compact". Routing it to `compact/stream` is entirely the client's job.
///
/// Everything *else* the server does refuse, with a sentence that names where to go
/// instead. We refuse it here too, with the same sentence, so the user is not made to
/// wait for a round trip to be told to use a button.
const compactCommand = '/compact';

class SlashCommand {
  const SlashCommand({required this.name, this.argHint, this.description = ''});

  final String name;
  final String? argHint;
  final String description;

  static SlashCommand fromJson(Map<String, dynamic> json) => SlashCommand(
    name: json['name'] as String? ?? '',
    argHint: json['argHint'] as String?,
    description: json['description'] as String? ?? '',
  );
}

class UnsupportedSlashCommand {
  const UnsupportedSlashCommand({required this.name, required this.guidance});

  final String name;

  /// Where the user should go instead — a Nelle UI control, not a prompt.
  final String guidance;

  static UnsupportedSlashCommand fromJson(Map<String, dynamic> json) =>
      UnsupportedSlashCommand(
        name: json['name'] as String? ?? '',
        guidance: json['guidance'] as String? ?? '',
      );
}

class SlashCommandRegistry {
  const SlashCommandRegistry({this.commands = const [], this.unsupported = const []});

  final List<SlashCommand> commands;
  final List<UnsupportedSlashCommand> unsupported;

  static SlashCommandRegistry fromJson(Map<String, dynamic> json) => SlashCommandRegistry(
    commands: [
      for (final c in (json['commands'] as List? ?? const []))
        SlashCommand.fromJson((c as Map).cast<String, dynamic>()),
    ],
    unsupported: [
      for (final c in (json['unsupported'] as List? ?? const []))
        UnsupportedSlashCommand.fromJson((c as Map).cast<String, dynamic>()),
    ],
  );
}

/// What ships in the binary: only what we cannot do without.
///
/// The real registry is **served** (`GET /api/commands`), so allowlisting a command needs
/// no client release — and bundling the server's 21 guidance sentences would be a copy
/// that goes stale the moment one changes. This exists solely so the composer can still
/// refuse `/model` before the fetch resolves.
const bundledRegistry = SlashCommandRegistry(
  commands: [
    SlashCommand(
      name: compactCommand,
      argHint: '[instructions]',
      description: 'Compact this conversation context',
    ),
  ],
);

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

/// The refusal a user sees for a command Nelle will not forward, or null when [value] is
/// an ordinary prompt or an allowed command.
///
/// Word for word the server's `unsupportedSlashCommandMessage`, so a command is refused
/// with one sentence, not two.
String? unsupportedSlashCommandMessage(
  String value, [
  SlashCommandRegistry registry = bundledRegistry,
]) {
  final command = parseSlashCommandName(value);
  if (command == null || registry.commands.any((c) => c.name == command)) {
    return null;
  }
  for (final known in registry.unsupported) {
    if (known.name == command) {
      return '$command is handled by Nelle UI. ${known.guidance}';
    }
  }
  final supported = registry.commands.map((c) => c.name).join(', ');
  return supported.isEmpty
      ? '$command is not supported in Nelle chat.'
      : '$command is not supported in Nelle chat. Supported commands: $supported.';
}

/// The served registry, which is the real one. Falls back to [bundledRegistry] only until
/// the request resolves, or if it fails — never a reason to stop someone typing.
final slashCommandsProvider = FutureProvider<SlashCommandRegistry>((ref) async {
  final dio = ref.watch(dioProvider);
  try {
    final res = await dio.get<Map<String, dynamic>>('/api/commands');
    final code = res.statusCode ?? 0;
    final data = res.data;
    // A non-2xx does NOT throw — dio is configured to hand back the body so a NelleError
    // can be read off it. Parsing an error body here would yield an *empty* registry,
    // which says "no commands are supported" and would refuse `/compact` itself.
    if (code < 200 || code >= 300 || data == null) {
      return bundledRegistry;
    }
    return SlashCommandRegistry.fromJson(data);
  } on DioException {
    return bundledRegistry;
  }
});
