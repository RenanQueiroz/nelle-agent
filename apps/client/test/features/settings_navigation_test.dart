import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/connection/connection_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

/// The Server screen inside a router whose `/` is a stand-in for the workbench, so the
/// test exercises the real back action rather than a mock of it.
///
/// It is reached from Settings > This device > Server now, but it stays independently
/// routable: a deep link or a restart can land straight on it, and it must not be the
/// dead end it was before M2.
Future<GoRouter> _pumpSettings(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({});
  final prefs = await SharedPreferences.getInstance();

  final router = GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(
        path: '/',
        builder: (context, state) => const Scaffold(body: Text('workbench')),
      ),
      GoRoute(
        path: '/connection',
        builder: (context, state) => const ConnectionScreen(),
      ),
    ],
  );

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        dioProvider.overrideWithValue(
          stubDio((o) => jsonResponse({'ok': true, 'app': 'nelle'})),
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
  await tester.pump();
  return router;
}

void main() {
  testWidgets('the Server screen is not a dead end: back gets out', (
    tester,
  ) async {
    final router = await _pumpSettings(tester);

    // The gear PUSHES, so there is something to pop. `go()` replaces the stack, which
    // left the user stranded here with no way out.
    router.push('/connection');
    await tester.pumpAndSettle();
    expect(find.text('Connection'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-connection-back')));
    await tester.pumpAndSettle();

    expect(find.text('workbench'), findsOneWidget);
    expect(find.text('Connection'), findsNothing);
  });

  testWidgets('back still escapes when the screen was not pushed', (
    tester,
  ) async {
    // A deep link or a restart can land straight on settings, with nothing to pop.
    // The screen must still let the user out rather than trapping them.
    final router = await _pumpSettings(tester);

    router.go('/connection');
    await tester.pumpAndSettle();
    expect(find.text('Connection'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-connection-back')));
    await tester.pumpAndSettle();

    expect(find.text('workbench'), findsOneWidget);
  });
}
