import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/connection/connection_screen.dart';

/// App routes. M1 has a single landing route; the workbench (conversation list +
/// chat) is added as the list and chat features land.
final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (context, state) => const ConnectionScreen()),
    ],
  );
});
