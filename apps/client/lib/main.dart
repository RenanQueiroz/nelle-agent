import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'src/app.dart';
import 'src/core/config.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Load persisted config up front so the base URL is available synchronously.
  final prefs = await SharedPreferences.getInstance();
  runApp(
    ProviderScope(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      child: const NelleApp(),
    ),
  );
}
