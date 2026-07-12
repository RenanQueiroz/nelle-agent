import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/llama_router_model.dart';
import 'package:nelle_agent/src/features/chat/chat_composer.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import 'package:nelle_agent/src/features/models/router_models_notifier.dart';

import '../helpers/fake_dio.dart';

/// A phone, not a desktop window.
///
/// Every drive before Android ran in a 1280px desktop window, which is wide enough to
/// hide a layout bug forever. This is a Pixel.
const _phone = Size(411, 891);

/// The model id this project actually tests against — and the reason the row overflowed.
/// A short id would fit, and would prove nothing.
const _modelId = 'unsloth/gemma-4-E4B-it-qat-GGUF:UD-Q4_K_XL';

/// llama.cpp is not running, so there is no live router status to overlay. Overriding
/// the notifier outright also keeps its `/models/sse` subscription (and the reattach
/// backoff timer it schedules when that stream ends) out of the test.
class _NoRouter extends RouterModelsNotifier {
  @override
  Future<List<LlamaRouterModel>> build() async => const [];
}

void main() {
  testWidgets('the composer fits a phone without overflowing', (tester) async {
    // Found on a real Android emulator, and by nothing else: the model and reasoning
    // selectors sat in an unflexed Row, wanted more width than a phone has, and Flutter
    // painted its yellow-and-black hazard stripes across the composer --
    // "OVERFLOWED BY 91 PIXELS". `flutter analyze` was clean and all 177 tests passed,
    // because the desktop window was simply wide enough for both.
    tester.view.physicalSize = _phone;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio(
              (options) => jsonResponse({
                'snapshot': snapshotJson(
                  defaultModelId: _modelId,
                  available: [
                    {'id': _modelId, 'alias': _modelId},
                  ],
                  reasoningLevel: 'low',
                  canReason: true,
                ),
              }),
            ),
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
            child: const FScaffold(child: ChatComposer(conversationId: 'c')),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    // Both selectors must actually be on screen: without them the row cannot overflow,
    // and this test would pass for the wrong reason -- which it did, until the stub was
    // fixed to hand the selector a model it could parse.
    expect(find.text('Model'), findsOneWidget);
    expect(find.text('Thinking'), findsOneWidget);

    // A RenderFlex overflow is reported as an exception in a test, which is the only
    // reason this is assertable at all. Verified to fail without the fix:
    //   "A RenderFlex overflowed by 115 pixels on the right."
    expect(tester.takeException(), isNull);
  });
}
