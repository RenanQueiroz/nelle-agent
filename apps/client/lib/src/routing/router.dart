import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/connection/connection_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/workbench/workbench_screen.dart';

/// App routes. `/` is the workbench (conversation list + selected chat);
/// `/settings` lists every settings section -- the server's and this device's.
///
/// `/connection` is still routable on its own: it is reached from inside `/settings`, but
/// a deep link straight to it must not land on a dead end.
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => const WorkbenchScreen()),
      GoRoute(
        path: '/settings',
        // `?section=<id>` lands on one destination — how a CTA elsewhere ("add a
        // model", "install llama.cpp") opens the right screen instead of the hub.
        builder: (context, state) => SettingsScreen(
          initialSection: state.uri.queryParameters['section'],
        ),
      ),
      GoRoute(
        path: '/connection',
        builder: (context, state) => const ConnectionScreen(),
      ),
    ],
  );
});
