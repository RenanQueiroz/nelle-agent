import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/connection/connection_screen.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

Widget _host(SharedPreferences prefs) => ProviderScope(
  overrides: [
    sharedPreferencesProvider.overrideWithValue(prefs),
    dioProvider.overrideWith(
      (ref) => stubDio((options) => jsonResponse({'app': 'nelle-server'})),
    ),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      child: const ConnectionScreen(),
    ),
  ),
);

void main() {
  testWidgets('the URL box follows the connection when it is unpaired underneath', (
    tester,
  ) async {
    // Found by driving. The box is seeded once in initState, so after a disconnect it
    // still read the LAN address while the app was back on loopback -- and pressing
    // "Save & test" would have pointed the app at the LAN server with **no certificate
    // pinned**, which is precisely the state this whole milestone exists to prevent.
    SharedPreferences.setMockInitialValues({
      'server_base_url': 'https://192.168.4.75:8788',
      'server_cert_fingerprint': '6F:20:CC:5E',
      'server_device_id': 'device-1',
    });
    final prefs = await SharedPreferences.getInstance();
    await tester.pumpWidget(_host(prefs));
    await tester.pumpAndSettle();

    // Paired: the manual box is not even shown -- a pairing *is* the connection, and an
    // editable URL beside it is a second, contradictory answer to the same question.
    expect(find.byKey(const ValueKey('k-connection-url')), findsNothing);
    expect(find.byKey(const ValueKey('k-paired-url')), findsOneWidget);

    // Disconnect.
    await tester.tap(find.byKey(const ValueKey('k-leave-server')));
    await tester.pumpAndSettle();

    final field = tester.widget<TextField>(
      find.descendant(
        of: find.byKey(const ValueKey('k-connection-url')),
        matching: find.byType(TextField),
      ),
    );
    expect(field.controller?.text, defaultServerBaseUrl);
    expect(field.controller?.text, isNot(contains('192.168.4.75')));
  });
}
