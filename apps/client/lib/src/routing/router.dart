import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/connection/connection_screen.dart';
import '../features/workbench/workbench_screen.dart';

/// App routes. `/` is the workbench (conversation list + selected chat);
/// `/connection` edits the server URL.
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => const WorkbenchScreen()),
      GoRoute(
        path: '/connection',
        builder: (context, state) => const ConnectionScreen(),
      ),
    ],
  );
});
