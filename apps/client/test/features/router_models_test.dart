import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import 'package:nelle_agent/src/features/models/router_models_notifier.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _model(
  String id, {
  String status = 'unloaded',
  num? progress,
}) => {
  'sectionId': id,
  'alias': id,
  'status': status,
  'aliases': <String>[id],
  'progress': ?progress,
};

Future<void> _settle() => Future.delayed(const Duration(milliseconds: 20));

void main() {
  ProviderContainer container(Stream<Map<String, dynamic>> routerEvents) {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio(
            (o) => jsonResponse({
              'models': [
                _model('E4B', status: 'unloaded'),
                _model('E2B', status: 'loaded'),
              ],
            }),
          ),
        ),
        sseTransportProvider.overrideWithValue(
          FakeTransport(
            const Stream<ChatStreamEvent>.empty(),
            jsonEvents: routerEvents,
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  test('lists the router models', () async {
    final c = container(const Stream.empty());

    final models = await c.read(routerModelsProvider.future);

    expect(models.map((m) => m.sectionId), ['E4B', 'E2B']);
    expect(models.first.status, 'unloaded');
  });

  test(
    'a router event updates the matching model status and progress',
    () async {
      final events = StreamController<Map<String, dynamic>>();
      addTearDown(events.close);
      final c = container(events.stream);
      await c.read(routerModelsProvider.future);

      events.add({
        'model': 'E4B',
        'data': {
          'status': 'loading',
          'progress': {'value': 0.42},
        },
      });
      await _settle();

      final models = c.read(routerModelsProvider).requireValue;
      expect(models.firstWhere((m) => m.sectionId == 'E4B').status, 'loading');
      expect(models.firstWhere((m) => m.sectionId == 'E4B').progress, 0.42);
      // The other model is untouched.
      expect(models.firstWhere((m) => m.sectionId == 'E2B').status, 'loaded');
    },
  );

  test(
    'an event that changes nothing the UI renders does not rebuild state',
    () async {
      final events = StreamController<Map<String, dynamic>>();
      addTearDown(events.close);
      final c = container(events.stream);
      await c.read(routerModelsProvider.future);

      final before = c.read(routerModelsProvider).requireValue;

      // E2B is already 'loaded'. llama.cpp re-announcing it (with a fresh payload)
      // must NOT thrash the selector.
      events.add({
        'model': 'E2B',
        'data': {'status': 'loaded'},
      });
      await _settle();

      final after = c.read(routerModelsProvider).requireValue;
      expect(
        identical(before, after),
        isTrue,
        reason: 'state was rebuilt for an unchanged model',
      );
    },
  );

  test('an event for an unknown model is ignored', () async {
    final events = StreamController<Map<String, dynamic>>();
    addTearDown(events.close);
    final c = container(events.stream);
    await c.read(routerModelsProvider.future);

    final before = c.read(routerModelsProvider).requireValue;
    events.add({
      'model': 'not-a-model',
      'data': {'status': 'loading'},
    });
    await _settle();

    expect(
      identical(before, c.read(routerModelsProvider).requireValue),
      isTrue,
    );
  });

  test(
    'isRunnableRouterStatus: loaded and sleeping are runnable, unloaded is not',
    () {
      expect(isRunnableRouterStatus('loaded'), isTrue);
      expect(isRunnableRouterStatus('sleeping'), isTrue);
      expect(isRunnableRouterStatus('unloaded'), isFalse);
      expect(isRunnableRouterStatus('loading'), isFalse);
    },
  );
}
