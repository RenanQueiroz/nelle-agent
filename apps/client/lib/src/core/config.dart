import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../features/connection/server_connection.dart';

/// Loopback address the Bun server binds by default.
const String defaultServerBaseUrl = 'http://127.0.0.1:8787';

/// Overridden in `main()` with the loaded instance so config is available
/// synchronously to the rest of the app.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) =>
      throw UnimplementedError('Override sharedPreferencesProvider in main()'),
);

/// The base URL of the server the app talks to.
///
/// Derived, not stored: the source of truth is `connectionProvider`, because a URL on
/// its own is only half a destination — a paired server also carries a pinned cert
/// fingerprint and a device id, and letting the URL move independently of those is how
/// a client ends up pinning one server's cert against another's address.
final serverBaseUrlProvider = Provider<String>(
  (ref) => ref.watch(connectionProvider).baseUrl,
);
