import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Loopback address the Bun server binds by default.
const String defaultServerBaseUrl = 'http://127.0.0.1:8787';

const String _baseUrlKey = 'server_base_url';

/// Overridden in `main()` with the loaded instance so config is available
/// synchronously to the rest of the app.
final sharedPreferencesProvider = Provider<SharedPreferences>(
  (ref) =>
      throw UnimplementedError('Override sharedPreferencesProvider in main()'),
);

/// The configured server base URL, persisted across launches. Changing it
/// rebuilds the dio client and re-runs the health check downstream.
final serverBaseUrlProvider = NotifierProvider<ServerBaseUrlNotifier, String>(
  ServerBaseUrlNotifier.new,
);

class ServerBaseUrlNotifier extends Notifier<String> {
  @override
  String build() {
    final stored = ref
        .watch(sharedPreferencesProvider)
        .getString(_baseUrlKey)
        ?.trim();
    return (stored == null || stored.isEmpty) ? defaultServerBaseUrl : stored;
  }

  /// Persists [url] (falling back to the default when blank) and updates state.
  Future<void> set(String url) async {
    final normalized = url.trim().isEmpty ? defaultServerBaseUrl : url.trim();
    await ref
        .read(sharedPreferencesProvider)
        .setString(_baseUrlKey, normalized);
    state = normalized;
  }
}
