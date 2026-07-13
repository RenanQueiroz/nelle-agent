import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:marionette_flutter/marionette_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/app.dart';
import 'src/core/config.dart';

Future<void> main() async {
  // **Whoever got here first owns the binding.**
  //
  // Nelle has two device-testing tools and they both want to install one. Marionette instruments
  // the app for agent-driven exploration (tap/type/screenshot over the VM service) and is
  // debug-only; `integration_test` installs `IntegrationTestWidgetsFlutterBinding` *before*
  // calling `main()`, because that is how it drives the app at all.
  //
  // Flutter permits exactly one. Grabbing it unconditionally in debug meant an
  // `integration_test` run died on launch with "Binding is already initialized to
  // IntegrationTestWidgetsFlutterBinding" — the two tools fighting over the same slot, which is
  // the concrete form of a question the M9 plan left open.
  //
  // They coexist by `main()` not fighting: if a binding exists, it was installed by whatever is
  // driving us, and it is the right one. A normal debug run has none, so Marionette still gets it.
  if (BindingBase.debugBindingType() == null) {
    if (kDebugMode) {
      MarionetteBinding.ensureInitialized();
    } else {
      WidgetsFlutterBinding.ensureInitialized();
    }
  }
  // Load persisted config up front so the base URL is available synchronously.
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const NelleApp(),
    ),
  );
}
