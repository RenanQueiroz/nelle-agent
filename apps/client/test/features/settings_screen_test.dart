import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/settings_schema.dart';
import 'package:nelle_agent/src/features/settings/settings_controller.dart';
import 'package:nelle_agent/src/features/settings/settings_section_screen.dart';
import 'package:nelle_agent/src/features/settings/settings_source.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

/// A section with one of every field type -- including one from the future.
SettingsSection _section() => SettingsSection.fromJson({
  'slug': 'demo',
  'title': 'Demo',
  'description': 'Everything at once.',
  'fields': [
    {
      'key': 'note',
      'label': 'Note',
      'help': 'One line.',
      'type': 'text',
      'default': '',
    },
    {
      'key': 'prompt',
      'label': 'Prompt',
      'help': 'Many lines.',
      'type': 'textarea',
      'default': 'hello',
      'maxLength': 8000,
    },
    {
      'key': 'words',
      'label': 'Words',
      'help': 'A count.',
      'type': 'number',
      'default': 6,
      'min': 1,
      'max': 20,
      'integer': true,
    },
    {
      'key': 'stats',
      'label': 'Stats',
      'help': 'A switch.',
      'type': 'boolean',
      'default': true,
    },
    {
      'key': 'mode',
      'label': 'Mode',
      'help': 'A choice.',
      'type': 'select',
      'default': 'llm',
      'options': [
        {'value': 'llm', 'label': 'Ask the model'},
        {'value': 'first-line', 'label': 'First line'},
      ],
    },
    // A type this build has never heard of.
    {
      'key': 'colour',
      'label': 'Colour',
      'help': 'From the future.',
      'type': 'colour-picker',
    },
  ],
});

/// Records what the section saved, and can refuse it the way the server does.
class _FakeSource implements SettingsSource {
  _FakeSource({this.values = const {}, this.refuseWith, this.refuseField});

  Map<String, Object?> values;
  final String? refuseWith;
  final String? refuseField;

  final List<Map<String, Object?>> saves = [];

  @override
  Future<Map<String, Object?>> read(String slug) async => values;

  @override
  Future<Map<String, Object?>> save(
    String slug,
    Map<String, Object?> patch,
  ) async {
    saves.add(patch);
    if (refuseWith != null) {
      throw SettingsSaveRefused(refuseWith!, fieldKey: refuseField);
    }
    values = {...values, ...patch};
    return values;
  }
}

Widget _host(SettingsSource source) => ProviderScope(
  overrides: [
    serverSettingsSourceProvider.overrideWithValue(source),
    dioProvider.overrideWithValue(stubDio((options) => jsonResponse({}))),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      child: SettingsSectionScreen(
        section: _section(),
        scope: const SettingsScope(slug: 'demo', isDevice: false),
      ),
    ),
  ),
);

void main() {
  // A tall viewport: the section is a lazy ListView, so on an 800x600 test surface the
  // Save button is never built and cannot be tapped. The app scrolls; the test does not.
  setUp(() {
    final view = TestWidgetsFlutterBinding.ensureInitialized()
        .platformDispatcher
        .views
        .first;
    view.physicalSize = const Size(900, 2000);
    view.devicePixelRatio = 1.0;
    addTearDown(view.reset);
  });

  testWidgets('every field type renders, and one from the future is skipped', (
    tester,
  ) async {
    await tester.pumpWidget(_host(_FakeSource()));
    await tester.pumpAndSettle();

    // Each control comes from the *schema*: nothing here knows what a "title mode" is.
    expect(find.byKey(const ValueKey('k-setting-note')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-setting-prompt')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-setting-words')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-setting-stats')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-setting-mode')), findsOneWidget);

    // A field type this build has never heard of renders as nothing -- and the five
    // around it still render. A newer server must not break an older client's settings
    // screen; that is the whole reason the schema is served.
    expect(find.byKey(const ValueKey('k-setting-colour')), findsNothing);
    expect(tester.takeException(), isNull);

    // The server's own labels and help text, not ours.
    expect(find.text('Words'), findsOneWidget);
    expect(find.text('A count.'), findsOneWidget);
    expect(find.text('Everything at once.'), findsOneWidget);
    // The bounds are shown, because the server sent them.
    expect(find.text('min 1 · max 20'), findsOneWidget);
  });

  testWidgets('a textarea is a textarea, not a one-line box', (tester) async {
    await tester.pumpWidget(_host(_FakeSource()));
    await tester.pumpAndSettle();

    final note = tester.widget<TextField>(
      find.descendant(
        of: find.byKey(const ValueKey('k-setting-note')),
        matching: find.byType(TextField),
      ),
    );
    final prompt = tester.widget<TextField>(
      find.descendant(
        of: find.byKey(const ValueKey('k-setting-prompt')),
        matching: find.byType(TextField),
      ),
    );

    // The distinction swagger_parser lost. 8,000 characters of custom instructions in a
    // single-line box is the bug that made the whole model hand-written.
    expect(note.maxLines, 1);
    expect(prompt.maxLines, greaterThan(1));
  });

  testWidgets('Save sends only the fields the user touched', (tester) async {
    final source = _FakeSource(values: {'words': 6, 'stats': true});
    await tester.pumpWidget(_host(source));
    await tester.pumpAndSettle();

    // Save does nothing until something is dirty -- asserted by tapping it, which is
    // what a user would do.
    await tester.tap(find.byKey(const ValueKey('k-settings-save')));
    await tester.pumpAndSettle();
    expect(source.saves, isEmpty);

    await tester.enterText(
      find.descendant(
        of: find.byKey(const ValueKey('k-setting-words')),
        matching: find.byType(TextField),
      ),
      '9',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('k-settings-save')));
    await tester.pumpAndSettle();

    // Only `words`. An untouched field is not sent, so a save cannot rewrite a value the
    // user never looked at -- which is how a settings screen quietly reverts something.
    expect(source.saves, [
      {'words': 9},
    ]);
  });

  testWidgets(
    "a refused save keeps the draft and shows the server's sentence on the field",
    (tester) async {
      final source = _FakeSource(
        refuseWith: 'Too big: expected number to be <=20',
        refuseField: 'words',
      );
      await tester.pumpWidget(_host(source));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.descendant(
          of: find.byKey(const ValueKey('k-setting-words')),
          matching: find.byType(TextField),
        ),
        '99',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-settings-save')));
      await tester.pumpAndSettle();

      // The server named the field (`error.detail`), so the sentence goes under *that*
      // control. At the bottom of a six-field form it would leave the user guessing.
      expect(
        find.byKey(const ValueKey('k-settings-error-words')),
        findsOneWidget,
      );
      expect(find.text('Too big: expected number to be <=20'), findsOneWidget);

      // And the draft survives. Making the user retype what the server refused -- and it
      // refused it *by name* -- would be a second insult.
      expect(find.text('99'), findsOneWidget);

      // Still dirty, so still saveable: tapping Save tries again.
      await tester.tap(find.byKey(const ValueKey('k-settings-save')));
      await tester.pumpAndSettle();
      expect(source.saves, hasLength(2));
    },
  );

  testWidgets('a refusal that names no field goes at the bottom', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(_FakeSource(refuseWith: 'The server is not having it.')),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-setting-stats')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('k-settings-save')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-settings-save-error')), findsOneWidget);
  });

  group('DeviceSettingsSource', () {
    test(
      'device values round-trip through SharedPreferences, namespaced by slug',
      () async {
        SharedPreferences.setMockInitialValues({});
        final prefs = await SharedPreferences.getInstance();
        final source = DeviceSettingsSource(prefs);

        expect(
          await source.read('appearance'),
          isEmpty,
          reason: 'a fresh install stores nothing',
        );

        await source.save('appearance', {
          'theme': 'dark',
          'scale': 1.2,
          'compact': true,
          'n': 3,
        });

        expect(await source.read('appearance'), {
          'theme': 'dark',
          'scale': 1.2,
          'compact': true,
          'n': 3,
        });
        // Namespaced, so a device group cannot collide with the connection or the tokens.
        expect(prefs.getString('settings.appearance.theme'), 'dark');
        // ...and another slug does not see it.
        expect(await source.read('other'), isEmpty);
      },
    );

    test('an absent value is not missing -- it is the field default', () async {
      // Which is what a fresh install *is*. The renderer falls back to the field's own
      // default, so a device group needs no seeding.
      SharedPreferences.setMockInitialValues({});
      final source = DeviceSettingsSource(
        await SharedPreferences.getInstance(),
      );
      expect(await source.read('appearance'), isEmpty);
    });
  });
}
