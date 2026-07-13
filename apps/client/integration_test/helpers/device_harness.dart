import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nelle_agent/main.dart' as app;
import 'package:shared_preferences/shared_preferences.dart';

/// What every device test needs before it can drive anything.
///
/// The app under test is the **real** one — `main()`, the real providers, the real dio, real HTTP
/// to a real Nelle server. Nothing is stubbed. That is the entire point: widget tests already stub
/// dio (309 of them), and they cannot see what only appears on a device.

/// The port the fixture server is on.
///
/// Passed in with `--dart-define`, never guessed: the harness that starts the server is the one
/// that knows, and a hard-coded 8787 would point the suite at whatever the developer happens to be
/// running — which is the same class of mistake as a llama.cpp probe on 8080.
const fixturePort = int.fromEnvironment('NELLE_FIXTURE_PORT', defaultValue: 8797);

/// The conversations `scripts/serve-fixture.ts` seeds. Kept in step by hand, because the fixture
/// is TypeScript and this is Dart; a test that looks for a chat the fixture never made fails
/// loudly, which is the failure mode to want.
abstract final class Fixture {
  static const withHistory = 'A conversation with history';
  static const aboutPelicans = 'Everything about pelicans';
  static const empty = 'An empty conversation';
}

/// Boots the real app, pointed at the fixture server.
///
/// **`127.0.0.1:<port>` is loopback**, so the fixture's trusted listener needs no device token —
/// which means the whole suite runs with no pairing, no TLS, no pin and no keyring. On Android the
/// same address works because the harness runs `adb reverse`, mapping the emulator's own loopback
/// to the host's port. (Pairing is not skipped out of laziness: it is already covered by
/// `devices.test.ts` server-side and three client test files, and making every device test carry a
/// TLS handshake and a Keystore write would be testing the harness.)
///
/// The connection is seeded through `SharedPreferences`, which `main()` reads at startup — so no
/// production code has a test hook in it. It also *overrides* whatever the developer's real app has
/// stored, which on this machine is a paired Android connection to a LAN address.
Future<void> launchApp(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({
    'server_base_url': 'http://127.0.0.1:$fixturePort',
  });

  app.main();
  await tester.pumpAndSettle(const Duration(seconds: 10));
}

/// The binding, and the one thing it must be true about.
///
/// `flutter_test` installs an `HttpOverrides` that fails every real network call. A device binding
/// must not — the app has to reach the fixture server. `integration_test/http_probe_test.dart`
/// asserts this directly; this is the belt to that's braces, because every other test in the suite
/// silently depends on it.
IntegrationTestWidgetsFlutterBinding initDeviceBinding() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  return binding;
}
