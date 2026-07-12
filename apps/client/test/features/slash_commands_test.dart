import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/chat/slash_commands.dart';

import '../helpers/fake_dio.dart';

/// The real registry, as `GET /api/commands` serves it.
final _served = {
  'commands': [
    {
      'name': '/compact',
      'argHint': '[instructions]',
      'description': 'Compact this conversation context',
    },
  ],
  'unsupported': [
    {
      'name': '/model',
      'guidance': 'Use the model selector in the composer or assistant footer.',
    },
    {
      'name': '/new',
      'guidance': 'Use the New chat button in the conversation sidebar.',
    },
  ],
};

void main() {
  test('an ordinary prompt is not a command', () {
    expect(unsupportedSlashCommandMessage('what is 17 x 23?'), isNull);
    expect(unsupportedSlashCommandMessage('use the /compact endpoint'), isNull);
  });

  test('/compact is allowed — it has its own endpoint', () {
    expect(unsupportedSlashCommandMessage('/compact'), isNull);
    expect(unsupportedSlashCommandMessage('/compact be brief'), isNull);
  });

  test(
    'a known Pi command is refused with the guidance the server wrote',
    () async {
      final c = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(stubDio((o) => jsonResponse(_served))),
        ],
      );
      addTearDown(c.dispose);
      final registry = await c.read(slashCommandsProvider.future);

      // Word for word the server's sentence, so a command is refused once, not twice.
      expect(
        unsupportedSlashCommandMessage('/model gemma', registry),
        '/model is handled by Nelle UI. '
        'Use the model selector in the composer or assistant footer.',
      );
      expect(
        unsupportedSlashCommandMessage('/new', registry),
        contains('Use the New chat button'),
      );
    },
  );

  test('an unknown command is refused, and told what IS supported', () async {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(stubDio((o) => jsonResponse(_served))),
      ],
    );
    addTearDown(c.dispose);
    final registry = await c.read(slashCommandsProvider.future);

    expect(
      unsupportedSlashCommandMessage('/wat', registry),
      '/wat is not supported in Nelle chat. Supported commands: /compact.',
    );
  });

  test('before the fetch resolves, the bundled registry still refuses', () {
    // The bundled copy holds no guidance sentences -- those are the server's, and a copy
    // of 21 of them would go stale the moment one changed. It exists only so /model is
    // still refused in the first second of the app's life.
    final refusal = unsupportedSlashCommandMessage('/model');
    expect(refusal, contains('/model is not supported'));
    expect(refusal, contains('/compact'));
  });

  test(
    'a failed /api/commands leaves the bundled registry, not an exception',
    () async {
      final c = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) => jsonResponse({'error': 'nope'}, status: 500)),
          ),
        ],
      );
      addTearDown(c.dispose);

      final registry = await c.read(slashCommandsProvider.future);
      expect(registry.commands.single.name, '/compact');
    },
  );

  test('the command name is lowercased, like the server does it', () {
    expect(parseSlashCommandName('/MODEL x'), '/model');
    expect(parseSlashCommandName('  /new  '), '/new');
    expect(parseSlashCommandName('hello'), isNull);
  });
}
