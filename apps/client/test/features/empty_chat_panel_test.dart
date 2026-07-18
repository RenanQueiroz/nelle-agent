import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/chat/empty_chat_panel.dart';

import '../helpers/fake_dio.dart';

/// The guided first-run path, in dependency order: no llama.cpp → install it; no models
/// → add one; not running → start it; ready → greet. Each state shows exactly one next
/// action, because a fresh install with three buttons is a quiz.
void main() {
  Map<String, dynamic> status({bool installed = true, bool running = true}) => {
    'platform': 'macos',
    'arch': 'arm64',
    'dataDir': '/data',
    'workspaceDir': '/home/user',
    'binaryPath': installed ? '/data/llama/llama-server' : null,
    'logPath': '/data/llama/llama-server.log',
    'installMode': 'github-release',
    'installed': installed,
    'installedVersion': installed ? 'b4521' : null,
    'previousVersion': null,
    'latestVersion': null,
    'updateAvailable': false,
    'running': running,
    'pid': running ? 4242 : null,
    'host': '127.0.0.1',
    'port': 8080,
    'modelsMax': 1,
    'sleepIdleSeconds': 300,
    'activeModelId': null,
    'lastError': null,
  };

  Map<String, dynamic> model() => {
    'id': 'org/repo:Q4',
    'name': 'org/repo:Q4',
    'presetName': 'org/repo:Q4',
    'source': 'huggingface',
    'repoId': 'org/repo',
    'quant': 'Q4',
    'hfRef': 'org/repo:Q4',
    'pinned': false,
    'diskBytes': 1000,
    'params': {'extra': <String, String>{}},
    'createdAt': '2026-07-01T00:00:00.000Z',
  };

  var startCalls = 0;

  Future<void> pump(
    WidgetTester tester, {
    required bool installed,
    required bool running,
    required List<Map<String, dynamic>> models,
  }) async {
    startCalls = 0;
    final router = GoRouter(
      initialLocation: '/',
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => const EmptyChatPanel(),
        ),
        GoRoute(
          path: '/settings',
          builder: (context, state) => Text(
            'settings:${state.uri.queryParameters['section']}',
          ),
        ),
      ],
    );
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.path.contains('/api/runtime/start')) {
                startCalls++;
                return jsonResponse(status(installed: installed, running: true));
              }
              if (options.path.contains('/api/runtime')) {
                return jsonResponse(
                  status(installed: installed, running: running),
                );
              }
              if (options.path.contains('/api/llama/')) {
                return jsonResponse({'models': <Object>[]});
              }
              // The models.ini catalog.
              return jsonResponse({
                'models': models,
                'activeModelId': null,
                'globalModelParams': <String, String>{},
              });
            }),
          ),
        ],
        child: MaterialApp.router(
          routerConfig: router,
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          builder: (context, child) => FTheme(
            data: FThemes.neutral.light.desktop,
            child: FToaster(child: child!),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('no llama.cpp: the one CTA is install, and it lands on the section', (
    tester,
  ) async {
    await pump(tester, installed: false, running: false, models: []);

    expect(find.byKey(const ValueKey('k-chat-cta-install')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-chat-cta-models')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('k-chat-cta-install')));
    await tester.pumpAndSettle();
    expect(find.text('settings:llamacpp'), findsOneWidget);
  });

  testWidgets('llama.cpp but no models: the one CTA is add-a-model', (
    tester,
  ) async {
    await pump(tester, installed: true, running: false, models: []);

    expect(find.byKey(const ValueKey('k-chat-cta-models')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-chat-cta-install')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('k-chat-cta-models')));
    await tester.pumpAndSettle();
    expect(find.text('settings:models'), findsOneWidget);
  });

  testWidgets('installed with models but stopped: start is offered RIGHT HERE', (
    tester,
  ) async {
    await pump(tester, installed: true, running: false, models: [model()]);

    expect(find.byKey(const ValueKey('k-chat-cta-start')), findsOneWidget);

    // The CTA acts, not navigates: settings is where you go when this fails.
    await tester.tap(find.byKey(const ValueKey('k-chat-cta-start')));
    await tester.pumpAndSettle();
    expect(startCalls, 1);
    expect(find.byKey(const ValueKey('k-chat-greeting')), findsOneWidget);
  });

  testWidgets('a keyboard-shrunk viewport scrolls the guide instead of overflowing', (
    tester,
  ) async {
    // On a phone the on-screen keyboard can leave the transcript ~150px tall, and a
    // fixed column painted overflow stripes there — Android CI caught it in a test
    // that merely typed into the search box.
    tester.view.physicalSize = const Size(500, 180);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await pump(tester, installed: false, running: false, models: []);

    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('k-chat-cta-install')), findsOneWidget);
  });

  testWidgets('everything ready: a greeting, not a checklist', (tester) async {
    await pump(tester, installed: true, running: true, models: [model()]);

    expect(find.byKey(const ValueKey('k-chat-greeting')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-chat-cta-install')), findsNothing);
    expect(find.byKey(const ValueKey('k-chat-cta-start')), findsNothing);
  });
}
