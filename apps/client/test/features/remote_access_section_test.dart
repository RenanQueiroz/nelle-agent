import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/pairing_payload.dart';
import 'package:nelle_agent/src/features/connection/remote_access.dart';
import 'package:nelle_agent/src/features/connection/remote_access_section.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../helpers/fake_dio.dart';

/// The app's **real** shell: forui over MaterialApp, with the screen itself an
/// `FScaffold`.
///
/// Note what this is *not*: the other widget tests here wrap their subject in a
/// Material `Scaffold`, which quietly supplies a `Material` ancestor the real screen
/// does not have. That harness is more forgiving than the app, and it is exactly how a
/// Material-only widget can pass every test and still paint a red error box the moment
/// anyone opens the screen.
Widget _host(
  Widget child, {
  bool lanEnabled = true,
  List<Map<String, Object?>> devices = const [],
}) => ProviderScope(
  overrides: [
    dioProvider.overrideWith(
      (ref) => stubDio((options) {
        return switch (options.path) {
          '/api/settings/network' => jsonResponse({
            'allowLanAccess': lanEnabled,
          }),
          '/api/settings/schema' => jsonResponse({
            'sections': [
              {
                'slug': 'network',
                'fields': [
                  {
                    'key': 'allowLanAccess',
                    'label': 'Allow LAN devices',
                    'help': 'Takes effect after a server restart.',
                    'type': 'boolean',
                  },
                ],
              },
            ],
          }),
          '/api/devices' => jsonResponse({'devices': devices}),
          '/api/pair/code' => jsonResponse({
            'code': 'JU32ZKU6',
            'expiresAt': '2026-07-12T21:00:00.000Z',
            'qrPayload': {
              'lanUrls': [
                'https://172.31.126.21:8788',
                'https://192.168.4.75:8788',
              ],
              'tlsPort': 8788,
              'certFingerprint': '6F:20:CC:5E',
              'code': 'JU32ZKU6',
              'expiresAt': '2026-07-12T21:00:00.000Z',
            },
          }),
          _ => jsonResponse({}),
        };
      }),
    ),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      child: FScaffold(child: SingleChildScrollView(child: child)),
    ),
  ),
);

Map<String, Object?> _device({String id = 'dev-1', String? lastSeenAt}) => {
  'id': id,
  'name': "Renan's phone",
  'platform': 'android',
  'createdAt': '2026-07-12T20:00:00.000Z',
  'lastSeenAt': lastSeenAt,
};

void main() {
  testWidgets('renders inside an FScaffold, with no Material ancestor', (
    tester,
  ) async {
    // The regression, found by driving the app and by nothing else. `Switch` and
    // `IconButton` are Material widgets: with no Material ancestor they throw "No
    // Material widget found" and Flutter paints a red error box where the control
    // should be. The analyzer is happy. Every unit test passes. The screen is broken
    // on sight.
    await tester.pumpWidget(_host(const RemoteAccessSection()));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
    expect(
      find.byType(FSwitch),
      findsOneWidget,
      reason: "forui's switch, not Material's",
    );
    expect(find.byType(Switch), findsNothing);
    expect(find.byType(IconButton), findsNothing);
  });

  testWidgets("the toggle's help text is the server's sentence, not ours", (
    tester,
  ) async {
    await tester.pumpWidget(_host(const RemoteAccessSection()));
    await tester.pumpAndSettle();

    // "Takes effect after a server restart" is the most important sentence on this
    // screen -- a toggle that appears to do nothing is otherwise a bug report -- and it
    // comes from GET /api/settings/schema rather than being retyped, so it cannot drift
    // from what the server actually does.
    expect(
      find.textContaining('Takes effect after a server restart'),
      findsOneWidget,
    );
    expect(find.text('Allow LAN devices'), findsOneWidget);
  });

  testWidgets('with LAN access off there is nothing to pair with', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const RemoteAccessSection(), lanEnabled: false),
    );
    await tester.pumpAndSettle();

    // A code minted with no listener behind it is a code that cannot be used.
    expect(find.byKey(const ValueKey('k-pair-device')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'an empty device list says so, rather than showing an empty box',
    (tester) async {
      await tester.pumpWidget(_host(const RemoteAccessSection()));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-devices-empty')), findsOneWidget);
    },
  );

  testWidgets('the QR carries the payload a device needs to FIND and TRUST the server', (
    tester,
  ) async {
    await tester.pumpWidget(_host(const RemoteAccessSection()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-pair-device')));
    await tester.pumpAndSettle();

    // A QR that renders but encodes nonsense looks exactly like one that works, so the
    // rendering is not the thing to assert on -- the payload is.
    expect(find.byType(QrImageView), findsOneWidget);
    final encoded =
        jsonDecode(
              pairingQrData(
                PairingPayload(
                  lanUrls: const [
                    'https://172.31.126.21:8788',
                    'https://192.168.4.75:8788',
                  ],
                  tlsPort: 8788,
                  certFingerprint: '6F:20:CC:5E',
                  code: 'JU32ZKU6',
                  expiresAt: '2026-07-12T21:00:00.000Z',
                ),
              ),
            )
            as Map<String, Object?>;

    // Every candidate address, because the server cannot know which one the phone can
    // see -- and the fingerprint, which is what makes the pin *pre-shared* rather than
    // trust-on-first-use. Drop either and the QR is decorative.
    expect(encoded['lanUrls'], [
      'https://172.31.126.21:8788',
      'https://192.168.4.75:8788',
    ]);
    expect(encoded['certFingerprint'], '6F:20:CC:5E');
    expect(encoded['code'], 'JU32ZKU6');

    // The code is also readable and typeable: the alphabet has no 0/O/1/I precisely so
    // it can be read aloud, and a desktop joining another desktop has no camera.
    expect(find.byKey(const ValueKey('k-pairing-code')), findsOneWidget);
    expect(find.text('JU32ZKU6'), findsOneWidget);
    // ...and the address is shown as text, for the same reason.
    expect(find.text('https://172.31.126.21:8788'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a paired device is listed with a way to remove it', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const RemoteAccessSection(), devices: [_device()]),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-device-dev-1')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-device-revoke-dev-1')), findsOneWidget);
    // A device that has paired but never called in again.
    expect(find.textContaining('never'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
