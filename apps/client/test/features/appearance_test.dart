import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/settings_schema.dart';
import 'package:nelle_agent/src/app.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/settings/device_settings.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

Future<void> _pumpApp(
  WidgetTester tester, {
  String? storedTheme,
  Brightness platform = Brightness.light,
}) async {
  SharedPreferences.setMockInitialValues(<String, Object>{
    'settings.appearance.themeMode': ?storedTheme,
  });
  final prefs = await SharedPreferences.getInstance();

  tester.platformDispatcher.platformBrightnessTestValue = platform;
  addTearDown(tester.platformDispatcher.clearPlatformBrightnessTestValue);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        dioProvider.overrideWithValue(
          stubDio(
            (options) =>
                jsonResponse({'conversations': <Object?>[], 'total': 0}),
          ),
        ),
      ],
      child: const NelleApp(),
    ),
  );
  await tester.pump();
  // MaterialApp animates a theme change (`AnimatedTheme`), so a short pump catches the
  // Material side mid-lerp and reads the brightness it is coming *from*. forui's theme is
  // not animated, which is exactly why the two must both be asserted -- and why a test
  // that only pumped once would have "passed" for the wrong reason.
  await tester.pump(const Duration(milliseconds: 400));
}

/// The brightness the *forui* theme resolved to — which is what the app actually looks
/// like, since almost every widget on screen is forui's.
Brightness _foruiBrightness(WidgetTester tester) =>
    tester.widget<FTheme>(find.byType(FTheme).first).data.colors.brightness;

/// ...and Material's, which must agree with it.
Brightness _materialBrightness(WidgetTester tester) =>
    Theme.of(tester.element(find.byType(FTheme).first)).brightness;

void main() {
  testWidgets('a dark override wins over a light OS -- in BOTH theme systems', (
    tester,
  ) async {
    // The landmine. `app.dart` built the forui theme from
    // `MediaQuery.platformBrightnessOf(context)` -- the OS's brightness, *directly*.
    // Harmless while there was no override; with one, MaterialApp switches to the light
    // Material theme while every forui widget stays dark, and the app renders half in
    // each. `flutter analyze` stays clean. You just look at it.
    //
    // Asserting only Material's brightness here would have passed while the app was
    // visibly broken, because what you see is forui.
    await _pumpApp(tester, storedTheme: 'dark', platform: Brightness.light);

    expect(_foruiBrightness(tester), Brightness.dark);
    expect(_materialBrightness(tester), Brightness.dark);
  });

  testWidgets('a light override wins over a dark OS -- in both', (
    tester,
  ) async {
    await _pumpApp(tester, storedTheme: 'light', platform: Brightness.dark);

    expect(_foruiBrightness(tester), Brightness.light);
    expect(_materialBrightness(tester), Brightness.light);
  });

  testWidgets('System follows the OS, which is why Appearance is device-local', (
    tester,
  ) async {
    // `system` resolves against *this* device's OS. A phone at night and a desktop in
    // daylight want different answers, so one stored value could not be right for both --
    // which is the whole argument for keeping this off the server.
    await _pumpApp(tester, storedTheme: 'system', platform: Brightness.dark);
    expect(_foruiBrightness(tester), Brightness.dark);

    await _pumpApp(tester, storedTheme: 'system', platform: Brightness.light);
    expect(_foruiBrightness(tester), Brightness.light);
  });

  testWidgets('an unset theme is System, not a crash', (tester) async {
    // A fresh install has stored nothing. The field falls back to its own default, which
    // is what a device source's absent value *means*.
    await _pumpApp(tester, platform: Brightness.dark);

    expect(_foruiBrightness(tester), Brightness.dark);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a stored value this build does not offer falls back to System', (
    tester,
  ) async {
    // A newer build might offer more modes. An older one must not be poisoned by a value
    // it cannot render.
    await _pumpApp(
      tester,
      storedTheme: 'solarized',
      platform: Brightness.light,
    );

    expect(_foruiBrightness(tester), Brightness.light);
    expect(tester.takeException(), isNull);
  });

  test('Appearance is described with the same types the server uses', () {
    // The proof the renderer is generic: a device section is a `SettingsSection` with a
    // `SelectSettingsField` in it -- exactly what comes off the wire -- so the same widget
    // draws it. If a device setting ever needs its own UI, the renderer is wrong.
    expect(appearanceSection.slug, appearanceSlug);
    expect(appearanceSection.fields, hasLength(1));

    final field = appearanceSection.fields.single;
    expect(field, isA<SelectSettingsField>());
    expect(field.key, themeModeKey);
    expect(
      (field as SelectSettingsField).options.map((option) => option.value),
      ['system', 'light', 'dark'],
    );
    expect(field.defaultValue, 'system');
  });
}
