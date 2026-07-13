import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/settings/host_tools.dart';

import '../helpers/fake_dio.dart';

const _warning =
    'They are not sandboxed. Anything the model decides to run, runs.';

Widget _host({
  required bool enabled,
  required bool acknowledged,
  List<Map<String, Object?>>? patches,
  bool refuseEnable = false,
}) {
  var state = <String, Object?>{
    'enabled': enabled,
    'acknowledged': acknowledged,
  };

  return ProviderScope(
    overrides: [
      dioProvider.overrideWithValue(
        stubDio((options) {
          if (options.method == 'PATCH') {
            final body = (options.data as Map).cast<String, Object?>();
            patches?.add(body);
            if (refuseEnable &&
                body['enabled'] == true &&
                state['acknowledged'] != true) {
              // Exactly what the server does: it *enforces* the gate rather than trusting
              // the client to render it.
              return jsonResponse({
                'error': {
                  'code': 'host_tools_acknowledgement_required',
                  'message':
                      'Host tools must be acknowledged before they can be enabled.',
                },
              }, status: 400);
            }
            state = {...state, ...body};
          }
          return jsonResponse({
            'hostTools': {...state, 'updatedAt': 't'},
            'warning': _warning,
            'description': 'Lets the model run shell commands.',
          });
        }),
      ),
    ],
    child: MaterialApp(
      theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
      home: FTheme(
        data: FThemes.neutral.light.desktop,
        child: const HostToolsScreen(),
      ),
    ),
  );
}

void main() {
  testWidgets('unacknowledged: there is no switch to turn on', (tester) async {
    await tester.pumpWidget(_host(enabled: false, acknowledged: false));
    await tester.pumpAndSettle();

    // Host tools are not a setting, they are a *gate*: unsandboxed shell access is a
    // decision, not a preference. So the control does not exist until the warning has
    // been read -- there is nothing to flip by accident.
    expect(find.byKey(const ValueKey('k-host-tools-enabled')), findsNothing);
    expect(
      find.byKey(const ValueKey('k-host-tools-acknowledge')),
      findsOneWidget,
    );
  });

  testWidgets("the warning is the SERVER's sentence, not the client's", (
    tester,
  ) async {
    await tester.pumpWidget(_host(enabled: false, acknowledged: false));
    await tester.pumpAndSettle();

    // A security warning each client writes for itself is the one copy you least want
    // drifting. This one is served, and both clients render it.
    expect(find.byKey(const ValueKey('k-host-tools-warning')), findsOneWidget);
    expect(find.textContaining('not sandboxed'), findsOneWidget);
  });

  testWidgets('acknowledging reveals the switch, and the warning stays', (
    tester,
  ) async {
    final patches = <Map<String, Object?>>[];
    await tester.pumpWidget(
      _host(enabled: false, acknowledged: false, patches: patches),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-host-tools-acknowledge')));
    await tester.pumpAndSettle();

    expect(patches, [
      {'acknowledged': true},
    ]);
    expect(find.byKey(const ValueKey('k-host-tools-enabled')), findsOneWidget);
    // The warning does not stop being true once it has been read.
    expect(find.byKey(const ValueKey('k-host-tools-warning')), findsOneWidget);
  });

  testWidgets('the switch turns them on once acknowledged', (tester) async {
    final patches = <Map<String, Object?>>[];
    await tester.pumpWidget(
      _host(enabled: false, acknowledged: true, patches: patches),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-host-tools-enabled')));
    await tester.pumpAndSettle();

    expect(patches, [
      {'enabled': true},
    ]);
  });

  testWidgets("a server refusal is shown, in the server's own words", (
    tester,
  ) async {
    // The client gate is UI; the *server* gate is the real one. It refuses `enabled`
    // without `acknowledged` outright (`host_tools_acknowledgement_required`), so a
    // second client that never rendered the warning gets nowhere. If that refusal ever
    // reaches this client, it must be shown rather than swallowed into a switch that
    // silently springs back.
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio(
              (options) => jsonResponse({
                'error': {
                  'code': 'host_tools_acknowledgement_required',
                  'message':
                      'Host tools must be acknowledged before they can be enabled.',
                },
              }, status: 400),
            ),
          ),
        ],
        child: MaterialApp(
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          home: FTheme(
            data: FThemes.neutral.light.desktop,
            child: const HostToolsScreen(),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-host-tools-error')), findsOneWidget);
    expect(find.textContaining('must be acknowledged'), findsOneWidget);
  });
}
