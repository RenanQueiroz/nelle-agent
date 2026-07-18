import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/llama_router_model.dart';
import 'package:nelle_agent/src/api/generated/models/reasoning_level.dart';
import 'package:nelle_agent/src/features/chat/reasoning_selector.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import 'package:nelle_agent/src/features/models/router_models_notifier.dart';
import 'package:nelle_agent/src/features/settings/reasoning_settings.dart';

import '../helpers/fake_dio.dart';

/// The composer's thinking picker: the trigger says the level and nothing else, and the
/// menu explains itself — a "Thinking budget" heading over rows titled by level with the
/// tokens each one buys underneath.
/// llama.cpp is not running, so there is no live router status to overlay. Overriding the
/// notifier outright also keeps its `/models/sse` subscription — and the reattach backoff
/// timer it schedules when that stream ends — out of the test.
class _NoRouter extends RouterModelsNotifier {
  @override
  Future<List<LlamaRouterModel>> build() async => const [];
}

void main() {
  const modelId = 'org/repo:Q4';

  Future<void> pumpSelector(
    WidgetTester tester, {
    ReasoningLevel level = ReasoningLevel.medium,
    Map<String, Object?>? budgets,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.path.contains('/api/settings/reasoning')) {
                return jsonResponse(
                  budgets ?? const {'low': 512, 'medium': 2048, 'high': 8192},
                );
              }
              return jsonResponse({
                'snapshot': snapshotJson(
                  defaultModelId: modelId,
                  available: [
                    {'id': modelId, 'alias': modelId},
                  ],
                  reasoningLevel: level.json!,
                  canReason: true,
                ),
              });
            }),
          ),
          sseTransportProvider.overrideWithValue(
            FakeTransport(const Stream<ChatStreamEvent>.empty()),
          ),
          routerModelsProvider.overrideWith(_NoRouter.new),
        ],
        child: MaterialApp(
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          home: FTheme(
            data: FThemes.neutral.light.desktop,
            child: const FScaffold(
              // Top-aligned, as the composer's Row hosts it. A bare scaffold child
              // stretches the select to the full surface height, which moves its centre
              // far below the field it actually draws — and then a tap at that centre
              // (what marionette and a device test do) lands on empty space.
              child: Align(
                alignment: Alignment.topLeft,
                child: ReasoningSelector(conversationId: 'c'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // The budgets request only starts on the build *after* the snapshot lands, and a
    // completing HTTP future schedules no frame of its own — so `pumpAndSettle` returns
    // with that request still in flight. Advance time to let it land, then settle the
    // rebuild it causes.
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pumpAndSettle();
  }

  /// Opens the menu by tapping the control itself — the same coordinate tap a person,
  /// a device test, or a marionette drive makes.
  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('k-composer-reasoning')));
    await tester.pumpAndSettle();
  }

  testWidgets('the trigger shows the level alone, not a sentence', (
    tester,
  ) async {
    await pumpSelector(tester, level: ReasoningLevel.max);

    expect(find.text('Max'), findsOneWidget);
    // The old labels said "Think: max" / "No thinking" in a 150px box beside the model
    // picker; the level's name is the whole of what the trigger has room to say.
    expect(find.textContaining('Think:'), findsNothing);
  });

  testWidgets('the menu heads itself and prices every level', (tester) async {
    await pumpSelector(tester);
    await openMenu(tester);

    expect(find.text('Thinking budget'), findsOneWidget);

    // Titles are the levels…
    for (final label in ['Off', 'Low', 'Medium', 'High', 'Max']) {
      expect(
        find.text(label),
        findsWidgets,
        reason: '$label must title a row',
      );
    }
    // …and the subtitles are what each one costs. `off` and `max` carry no budget at
    // all — the server sends none for either — so neither invents a number.
    expect(find.text('512 tokens'), findsOneWidget);
    expect(find.text('2048 tokens'), findsOneWidget);
    expect(find.text('8192 tokens'), findsOneWidget);
    expect(find.text('The model answers without thinking'), findsOneWidget);
    expect(find.text('Unlimited'), findsOneWidget);
  });

  testWidgets('the budgets are the SERVER\'s, and 0 reads as unlimited', (
    tester,
  ) async {
    // Not the client's defaults: a user who set Low to 4096 in settings must see 4096
    // here. And `0` is the server's spelling of "no cap" (UNLIMITED_REASONING_BUDGET),
    // never a level that thinks for zero tokens.
    await pumpSelector(
      tester,
      budgets: const {'low': 4096, 'medium': 0, 'high': 8192},
    );
    await openMenu(tester);

    expect(find.text('4096 tokens'), findsOneWidget);
    expect(find.text('512 tokens'), findsNothing);
    // Medium (0) joins Max in reading as unlimited.
    expect(find.text('Unlimited'), findsNWidgets(2));
    expect(find.text('0 tokens'), findsNothing);
  });

  testWidgets('picking a level sends it to the server', (tester) async {
    await pumpSelector(tester, level: ReasoningLevel.off);
    await openMenu(tester);

    await tester.tap(find.byKey(const ValueKey('k-composer-reasoning-high')));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  group('ReasoningBudgets', () {
    test('mirrors the server rule for which levels carry a budget', () {
      const budgets = ReasoningBudgets(low: 512, medium: 0, high: 8192);

      expect(budgets.tokensFor(ReasoningLevel.low), 512);
      expect(budgets.tokensFor(ReasoningLevel.high), 8192);
      // 0 is unlimited, and off/max never carry one.
      expect(budgets.tokensFor(ReasoningLevel.medium), isNull);
      expect(budgets.tokensFor(ReasoningLevel.off), isNull);
      expect(budgets.tokensFor(ReasoningLevel.max), isNull);
    });

    test('falls back to the server defaults for junk or missing values', () {
      final parsed = ReasoningBudgets.fromJson(const {
        'low': 'nonsense',
        'high': -5,
      });

      expect(parsed.low, 512);
      expect(parsed.medium, 2048);
      expect(parsed.high, 8192);
    });
  });
}
