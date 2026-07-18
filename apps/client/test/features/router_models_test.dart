import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
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

class _CancelledListAdapter implements HttpClientAdapter {
  final started = Completer<void>();
  final cancelled = Completer<void>();

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    started.complete();
    await cancelFuture;
    cancelled.complete();
    throw DioException(
      requestOptions: options,
      type: DioExceptionType.cancel,
      message: 'provider disposed',
    );
  }

  @override
  void close({bool force = false}) {}
}

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
    'disposing cancels an initial listing without leaking an error',
    () async {
      final adapter = _CancelledListAdapter();
      final dio = Dio(
        BaseOptions(baseUrl: 'http://test.local', validateStatus: (_) => true),
      )..httpClientAdapter = adapter;
      final c = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(dio),
          sseTransportProvider.overrideWithValue(
            FakeTransport(const Stream<ChatStreamEvent>.empty()),
          ),
        ],
      );

      final listing = c.read(routerModelsProvider.future);
      await adapter.started.future;
      c.dispose();

      await adapter.cancelled.future.timeout(const Duration(seconds: 1));
      await expectLater(listing, completion(isEmpty));
      dio.close(force: true);
    },
  );

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

  test('progress does not outlive the load it belonged to', () async {
    final events = StreamController<Map<String, dynamic>>();
    addTearDown(events.close);
    final c = container(events.stream);
    await c.read(routerModelsProvider.future);

    events.add({
      'model': 'E4B',
      'data': {
        'status': 'loading',
        'progress': {'value': 0.9},
      },
    });
    await _settle();
    events.add({
      'model': 'E4B',
      'data': {'status': 'loaded'},
    });
    await _settle();

    final loaded = c
        .read(routerModelsProvider)
        .requireValue
        .firstWhere((m) => m.sectionId == 'E4B');
    expect(loaded.status, 'loaded');
    // Keeping 0.9 here would put a stale percentage on screen the next time it loads.
    expect(loaded.progress, isNull);
  });

  test('a measurement-less frame does not reset a load in flight', () async {
    final events = StreamController<Map<String, dynamic>>();
    addTearDown(events.close);
    final c = container(events.stream);
    await c.read(routerModelsProvider.future);

    events.add({
      'model': 'E4B',
      'data': {
        'status': 'loading',
        'progress': {
          'stages': ['text_model', 'mmproj_model'],
          'current': 'text_model',
          'value': 1.0,
        },
      },
    });
    await _settle();
    // llama.cpp's bare stage announcement, sent between stages.
    events.add({
      'model': 'E4B',
      'data': {
        'status': 'loading',
        'progress': {'stage': 'mmproj_model'},
      },
    });
    await _settle();

    final model = c
        .read(routerModelsProvider)
        .requireValue
        .firstWhere((m) => m.sectionId == 'E4B');
    // Still half way through the whole load — not back to zero, not unknown.
    expect(model.progress, 0.5);
  });

  test(
    'the stream reattaches after llama.cpp drops it, and re-lists',
    () async {
      // llama.cpp stopping ENDS the stream rather than failing it. Without a reattach
      // the selector's status would freeze at whatever it last saw, forever.
      var lists = 0;
      final streams = <StreamController<Map<String, dynamic>>>[];
      final c = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              lists++;
              return jsonResponse({
                // The second listing is what a restarted llama.cpp reports.
                'models': [
                  _model('E4B', status: lists == 1 ? 'unloaded' : 'loaded'),
                ],
              });
            }),
          ),
          sseTransportProvider.overrideWithValue(
            FakeTransport(
              const Stream<ChatStreamEvent>.empty(),
              jsonEventsBuilder: () {
                final controller = StreamController<Map<String, dynamic>>();
                streams.add(controller);
                return controller.stream;
              },
            ),
          ),
        ],
      );
      addTearDown(c.dispose);

      await c.read(routerModelsProvider.future);
      expect(lists, 1);
      expect(streams, hasLength(1));

      // llama.cpp goes away: the stream simply ends.
      await streams.first.close();
      // Wait out the reattach backoff (2s).
      await Future<void>.delayed(const Duration(milliseconds: 2600));

      expect(lists, 2, reason: 'did not re-list after the stream dropped');
      expect(
        streams,
        hasLength(2),
        reason: 'did not reattach the event stream',
      );
      expect(
        c.read(routerModelsProvider).requireValue.single.status,
        'loaded',
        reason: 'did not pick up the restarted router\'s state',
      );
      for (final s in streams) {
        unawaited(s.close());
      }
    },
    timeout: const Timeout(Duration(seconds: 20)),
  );

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
