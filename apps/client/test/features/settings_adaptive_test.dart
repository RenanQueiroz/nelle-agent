import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/settings/settings_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

/// Settings is responsive the way the workbench is: a phone gets the grouped list and
/// pushes each destination; a desktop gets a sidebar with the destination hosted beside
/// it. Both layouts render from one destination registry, and these tests pin the split —
/// because the desktop half only exists on windows wider than the default test surface,
/// a regression here is exactly the kind widget tests otherwise never see.
void main() {
  Map<String, Object?> schema() => {
    'sections': [
      {
        'slug': 'general',
        'title': 'General',
        'description': 'The first section.',
        'fields': [
          {'key': 'note', 'type': 'text', 'label': 'Note'},
        ],
      },
      {
        'slug': 'titles',
        'title': 'Titles',
        'description': 'The second section.',
        'fields': [
          {'key': 'maxWords', 'type': 'text', 'label': 'Max words'},
        ],
      },
    ],
  };

  Future<void> pumpSettings(WidgetTester tester, {required Size size}) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    final router = GoRouter(
      initialLocation: '/settings',
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => const Scaffold(body: Text('workbench')),
        ),
        GoRoute(
          path: '/settings',
          builder: (context, state) => const SettingsScreen(),
        ),
      ],
    );

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.path.contains('/api/settings/schema')) {
                return jsonResponse(schema());
              }
              // Section values, health, and anything else a pane asks for.
              return jsonResponse(const <String, Object?>{});
            }),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          builder: (context, child) =>
              FTheme(data: FThemes.neutral.light.desktop, child: child!),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('wide: a sidebar hosts the first section beside it', (
    tester,
  ) async {
    await pumpSettings(tester, size: const Size(1280, 900));

    // The sidebar exists, the first schema section is selected by default, and its
    // form is hosted in the pane — no navigation happened.
    expect(find.byType(FSidebar), findsOneWidget);
    expect(
      find.byKey(const ValueKey('k-settings-pane-general')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('k-settings-save')), findsOneWidget);
    // Hosted, not pushed: the pane carries no back affordance of its own.
    expect(find.byKey(const ValueKey('k-settings-section-back')), findsNothing);
  });

  testWidgets('wide: selecting in the sidebar swaps the pane', (tester) async {
    await pumpSettings(tester, size: const Size(1280, 900));

    await tester.tap(find.byKey(const ValueKey('k-settings-section-titles')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('k-settings-pane-titles')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('k-settings-pane-general')), findsNothing);
    expect(find.text('The second section.'), findsOneWidget);
  });

  testWidgets('narrow: the grouped list pushes a standalone section', (
    tester,
  ) async {
    await pumpSettings(tester, size: const Size(500, 900));

    // No sidebar on a phone; the grouped list is the whole screen.
    expect(find.byType(FSidebar), findsNothing);
    expect(find.text('These follow you to every device.'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-settings-section-general')));
    await tester.pumpAndSettle();

    // Pushed as its own screen, back affordance and all.
    expect(
      find.byKey(const ValueKey('k-settings-section-back')),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('k-settings-save')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-settings-section-back')));
    await tester.pumpAndSettle();
    expect(find.text('These follow you to every device.'), findsOneWidget);
  });
}
