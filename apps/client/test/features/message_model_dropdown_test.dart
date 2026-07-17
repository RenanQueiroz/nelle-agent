import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/features/chat/message_model_dropdown.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

import '../helpers/fake_dio.dart';

/// Two configured models, so the footer dropdown can offer a switch.
const _available = <Map<String, dynamic>>[
  {'id': 'E4B', 'alias': 'gemma E4B'},
  {'id': 'E2B', 'alias': 'gemma E2B'},
];

void main() {
  testWidgets(
    'picking a model repins the conversation default AND regenerates the message',
    (tester) async {
      String? patchedDefault;
      final events = StreamController<ChatStreamEvent>();
      addTearDown(() => unawaited(events.close()));
      // A router SSE that never ends, so the notifier schedules no reattach timer to leak.
      final transport = FakeTransport(
        events.stream,
        jsonEventsBuilder: () =>
            Stream<Map<String, dynamic>>.periodic(const Duration(days: 1)),
      );

      final dio = stubDio((o) {
        if (o.method == 'PATCH' && o.path == '/api/conversations/c') {
          patchedDefault = (o.data as Map)['defaultModelId'] as String?;
          return jsonResponse({
            'conversation': {'id': 'c'},
            'snapshot': snapshotJson(
              available: _available,
              defaultModelId: 'E2B',
            ),
          });
        }
        if (o.path == '/api/settings/preferences') {
          return jsonResponse({'favoriteModelIds': <String>[]});
        }
        if (o.path.contains('/api/llama/models')) {
          return jsonResponse({'models': <Object>[]});
        }
        return jsonResponse({
          'snapshot': snapshotJson(available: _available, defaultModelId: 'E4B'),
        });
      });

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
            sseTransportProvider.overrideWithValue(transport),
          ],
          child: MaterialApp(
            theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
            home: FTheme(
              data: FThemes.neutral.light.desktop,
              child: const FToaster(
                child: FScaffold(
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: MessageModelDropdown(
                      conversationId: 'c',
                      messageId: 'm1',
                      currentModelId: 'E4B',
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The trigger names the model that produced this answer.
      expect(find.text('gemma E4B'), findsOneWidget);

      // Open it — both models are offered.
      await tester.tap(find.byKey(const ValueKey('k-msg-model-m1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('k-msg-model-item-E4B')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-msg-model-item-E2B')), findsOneWidget);

      // Pick the other one.
      await tester.tap(find.byKey(const ValueKey('k-msg-model-item-E2B')));
      await tester.pumpAndSettle();

      // Both halves happened: the conversation default was repinned (going forward)...
      expect(patchedDefault, 'E2B');
      // ...and this message was regenerated with the chosen model as an override.
      expect(transport.lastPath, '/api/conversations/c/messages/m1/regenerate');
      expect((transport.lastBody! as Map)['modelId'], 'E2B');
    },
  );
}
