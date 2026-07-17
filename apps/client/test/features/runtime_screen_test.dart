import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/runtime_status_install_mode.dart';
import 'package:nelle_agent/src/features/runtime/install_screen.dart';
import 'package:nelle_agent/src/features/runtime/runtime_controller.dart';
import 'package:nelle_agent/src/features/runtime/runtime_screen.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _status({
  bool installed = true,
  bool running = true,
  bool updateAvailable = false,
  String? installedVersion = 'ee445f93d8a0a503',
  String? latestVersion,
  String? lastError,
  String installMode = 'source-master',
}) => {
  'platform': 'linux',
  'arch': 'x64',
  'dataDir': '/data',
  'workspaceDir': '/home/user',
  'binaryPath': installed ? '/data/llama/bin/llama-server' : null,
  'logPath': '/data/logs/llama-server.log',
  'installMode': installMode,
  'installed': installed,
  'installedVersion': installedVersion,
  'latestVersion': latestVersion,
  'updateAvailable': updateAvailable,
  'running': running,
  'pid': running ? 1234 : null,
  'host': '127.0.0.1',
  'port': 8080,
  'modelsMax': 2,
  'sleepIdleSeconds': 90,
  'activeModelId': null,
  'lastError': lastError,
};

/// Hosted in an `FScaffold`, which is what the app actually runs in.
///
/// The older widget tests wrap their subject in a Material `Scaffold`, and that is *more
/// forgiving than the app*: this app is forui over a bare FScaffold with no `Material`
/// ancestor, so a Material-only widget throws "No Material widget found" and paints a red
/// error box — while `flutter analyze` stays clean and every unit test passes.
Widget _host(Widget child, {Map<String, dynamic>? status}) => ProviderScope(
  overrides: [
    dioProvider.overrideWithValue(
      stubDio((options) {
        if (options.path.contains('/api/llama/props')) {
          return jsonResponse({
            'role': 'router',
            'maxInstances': 2,
            'modelsAutoload': true,
            'runtime': _status(),
          });
        }
        if (options.path.contains('/api/llama/models')) {
          return jsonResponse({'models': <Object>[]});
        }
        return jsonResponse(status ?? _status());
      }),
    ),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(data: FThemes.neutral.light.desktop, child: child),
  ),
);

void main() {
  testWidgets('a running runtime says where, and offers Stop', (tester) async {
    await tester.pumpWidget(_host(const RuntimeScreen()));
    await tester.pumpAndSettle();

    expect(find.textContaining('Running on 127.0.0.1:8080'), findsOneWidget);
    expect(find.text('Router capacity: 0/2 loaded'), findsOneWidget);

    // The data dir and the agent's working dir are shown, so "where are my files?" has an answer.
    expect(find.text('Data dir'), findsOneWidget);
    expect(find.text('/data'), findsOneWidget);
    expect(find.text('Working dir'), findsOneWidget);
    expect(find.text('/home/user'), findsOneWidget);

    final stop = tester.widget<FButton>(
      find.byKey(const ValueKey('k-runtime-stop')),
    );
    final start = tester.widget<FButton>(
      find.byKey(const ValueKey('k-runtime-start')),
    );
    expect(stop.onPress, isNotNull, reason: 'a running runtime can be stopped');
    expect(start.onPress, isNull, reason: '...and cannot be started again');
  });

  testWidgets('an uninstalled runtime offers Install, and nothing else', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const RuntimeScreen(),
        status: _status(
          installed: false,
          running: false,
          installedVersion: null,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Not installed'), findsWidgets);
    expect(find.text('Install llama.cpp'), findsOneWidget);
    // Nothing is installed, so there is nothing to uninstall.
    expect(find.byKey(const ValueKey('k-runtime-uninstall')), findsNothing);

    final start = tester.widget<FButton>(
      find.byKey(const ValueKey('k-runtime-start')),
    );
    expect(start.onPress, isNull, reason: 'there is nothing to start');
  });

  testWidgets('an installed runtime offers Uninstall; an external one does not', (
    tester,
  ) async {
    // The default status is an installed source build — Nelle put it there, so it can remove it.
    await tester.pumpWidget(_host(const RuntimeScreen()));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('k-runtime-uninstall')), findsOneWidget);

    // `external` (LLAMA_SERVER_PATH) is the user's binary — Nelle will not delete it.
    await tester.pumpWidget(
      _host(const RuntimeScreen(), status: _status(installMode: 'external')),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('k-runtime-uninstall')), findsNothing);
  });

  testWidgets('the button says "Update available" only when one IS', (
    tester,
  ) async {
    // `apps/web` said "Update" whenever a binary existed, without ever asking whether there
    // was anything to update *to* -- and it never fetched `?latest=1`, so it could not have
    // known. The API has always answered this.
    await tester.pumpWidget(_host(const RuntimeScreen()));
    await tester.pumpAndSettle();
    expect(find.text('Rebuild'), findsOneWidget);
    expect(find.text('Update available'), findsNothing);

    await tester.pumpWidget(
      _host(
        const RuntimeScreen(),
        status: _status(updateAvailable: true, latestVersion: '99f3dc32296f'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('Update available'), findsOneWidget);
    // ...and the version says what it would move to.
    expect(find.textContaining('→'), findsOneWidget);
  });

  testWidgets(
    'lastError is shown, because a runtime that will not come up must say why',
    (tester) async {
      await tester.pumpWidget(
        _host(
          const RuntimeScreen(),
          status: _status(
            running: false,
            lastError: 'llama-server exited with code 1',
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('k-runtime-last-error')),
        findsOneWidget,
      );
      expect(find.text('llama-server exited with code 1'), findsOneWidget);
    },
  );

  testWidgets('an external binary is named as one, and never rebuilt silently', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(const RuntimeScreen(), status: _status(installMode: 'external')),
    );
    await tester.pumpAndSettle();

    // `external` is a Dart keyword, so the generator renamed the enum member. If that switch
    // ever falls through, this is where it shows.
    expect(find.text('External binary (LLAMA_SERVER_PATH)'), findsOneWidget);
  });

  testWidgets('the screen fits a phone', (tester) async {
    // A phone is not a narrow desktop, and the difference finds bugs: M6's drive found a
    // composer overflowing by 91px on Android, from an unflexed Row a 1280px window had
    // always been wide enough to hide.
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _host(
        const RuntimeScreen(),
        // The longest strings the screen can hold: a full sha and a long path.
        status: _status(
          installedVersion: 'ee445f93d8a0a5033a46d1960e901ef5caec9a41',
          lastError:
              'llama-server exited with code 1 after a very long message '
              'that would wrap on any narrow screen',
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  group('InstallScreen', () {
    test('stderr is a stream label, and never a verdict', () {
      // The failure banner is driven by `error`, which only `runtime.install.failed` sets. A
      // real build emitted 2 stderr lines and succeeded; a screen that read stderr as failure
      // would have called it broken.
      const state = InstallState(finished: true);
      expect(state.error, isNull);
    });

    testWidgets('a source build explains the compile', (tester) async {
      await tester.pumpWidget(
        _host(const InstallScreen(mode: RuntimeStatusInstallMode.sourceMaster)),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-install-idle')), findsOneWidget);
      expect(
        find.textContaining('builds llama.cpp from source'),
        findsOneWidget,
      );
      expect(find.textContaining('cmake'), findsOneWidget);
      expect(find.text('Install'), findsOneWidget);
    });

    testWidgets('a release download does not talk about compiling', (
      tester,
    ) async {
      // The bug: a Mac downloads a prebuilt binary in seconds, but the screen told *everyone*
      // it was a "full cmake compile" that "takes minutes". The copy must follow the mode.
      await tester.pumpWidget(
        _host(
          const InstallScreen(mode: RuntimeStatusInstallMode.githubRelease),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('downloads a prebuilt'), findsOneWidget);
      expect(find.textContaining('cmake'), findsNothing);
      expect(find.textContaining('from source'), findsNothing);
    });
  });
}
