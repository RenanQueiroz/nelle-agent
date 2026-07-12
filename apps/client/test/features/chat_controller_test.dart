import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/nelle_error.dart';
import 'package:nelle_agent/src/api/generated/models/reasoning_level.dart';
import 'package:nelle_agent/src/features/chat/chat_controller.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

import '../helpers/fake_dio.dart';

Future<void> _settle() => Future.delayed(const Duration(milliseconds: 20));

void main() {
  /// Closes [events] after the test, dropping the future `close()` returns.
  ///
  /// A single-subscription controller nothing ever listened to never completes its
  /// `close()`, and `addTearDown` awaits what it is handed — so a test that never
  /// sends (and so never subscribes to the stream) would hang instead of finishing.
  void closeAfterTest(StreamController<ChatStreamEvent> events) =>
      addTearDown(() => unawaited(events.close()));

  ProviderContainer container(Stream<ChatStreamEvent> events, {Dio? dio}) {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          dio ?? stubDio((o) => jsonResponse({'snapshot': snapshotJson()})),
        ),
        sseTransportProvider.overrideWithValue(FakeTransport(events)),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  test('send appends an optimistic user + streaming assistant turn', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hello');

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.running, true);
    expect(state.pending.map((m) => m.content), ['hello', '']);
  });

  test('folds content and reasoning deltas into the assistant turn', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hello');

    events.add(const AssistantReasoningDeltaEvent(id: 'm', delta: 'hmm'));
    events.add(const AssistantDeltaEvent(id: 'm', delta: 'Hel'));
    events.add(const AssistantDeltaEvent(id: 'm', delta: 'lo'));
    await _settle();

    final assistant = c
        .read(chatControllerProvider('c'))
        .requireValue
        .pending
        .last;
    expect(assistant.content, 'Hello');
    expect(assistant.reasoning, 'hmm');
  });

  test('model.loading sets progress and the first delta clears it', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');

    events.add(
      const ModelLoadingEvent(modelId: 'm', status: 'loading', progress: 0.5),
    );
    await _settle();
    expect(c.read(chatControllerProvider('c')).requireValue.loadingModel, true);

    events.add(const AssistantDeltaEvent(id: 'm', delta: 'x'));
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.modelLoadProgress,
      isNull,
    );
  });

  test('a load with no measurement yet is loading, not 0%', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');

    // llama.cpp's first frames carry no value at all.
    events.add(const ModelLoadingEvent(modelId: 'm', status: 'loading'));
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    // The placeholder must show — and it must not invent a number the server never
    // sent, which is what deriving "loading" from "progress != null" would force.
    expect(state.loadingModel, isTrue);
    expect(state.modelLoadProgress, isNull);
  });

  test('a runnable status ends the load even before the first token', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(
      const ModelLoadingEvent(modelId: 'm', status: 'loading', progress: 0.5),
    );
    await _settle();
    expect(c.read(chatControllerProvider('c')).requireValue.loadingModel, true);

    // The server polls until the model is up and reports what it last saw.
    events.add(const ModelLoadingEvent(modelId: 'm', status: 'loaded'));
    await _settle();

    expect(
      c.read(chatControllerProvider('c')).requireValue.loadingModel,
      isFalse,
      reason: 'the placeholder outlived the load it was describing',
    );
  });

  test(
    'run.completed reloads the authoritative snapshot and clears pending',
    () async {
      var gets = 0;
      final dio = stubDio((o) {
        if (o.method == 'GET') {
          gets++;
          return jsonResponse({
            'snapshot': snapshotJson(
              messages: gets == 1
                  ? const []
                  : [
                      {
                        'id': 'm',
                        'role': 'assistant',
                        'content': 'Hi there',
                        'createdAt': 't',
                      },
                    ],
            ),
          });
        }
        return jsonResponse({'ok': true});
      });
      final events = StreamController<ChatStreamEvent>();
      final c = container(events.stream, dio: dio);

      await c.read(chatControllerProvider('c').future);
      await c.read(chatControllerProvider('c').notifier).send('hi');
      events.add(const RunCompletedEvent(status: 'completed'));
      await events.close();
      await _settle();

      final state = c.read(chatControllerProvider('c')).requireValue;
      expect(state.running, false);
      expect(state.pending, isEmpty);
      expect(state.messages.map((m) => m.content), contains('Hi there'));
    },
  );

  test(
    'a refused message (no run.started) is handed back to the composer',
    () async {
      final events = StreamController<ChatStreamEvent>();
      final c = container(events.stream);

      await c.read(chatControllerProvider('c').future);
      await c.read(chatControllerProvider('c').notifier).send('keep me');
      // The server refuses before the message ever becomes a turn.
      events.add(
        StreamErrorEvent(
          NelleError(code: 'llama_server_stopped', message: 'not running'),
        ),
      );
      await events.close();
      await _settle();

      final state = c.read(chatControllerProvider('c')).requireValue;
      expect(state.refusedMessage, 'keep me');
      // and it is not left in the transcript as if it had been sent
      expect(state.pending, isEmpty);
      expect(state.messages, isEmpty);
    },
  );

  test('a message that became a turn is never handed back', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('real turn');
    events.add(const RunStartedEvent(runId: 'r'));
    events.add(
      StreamErrorEvent(
        NelleError(code: 'context_overflow', message: 'too big'),
      ),
    );
    await events.close();
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.refusedMessage, isNull);
    expect(state.runError, 'too big');
  });

  test('consumeRefusedMessage clears it', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('keep me');
    events.add(StreamErrorEvent(NelleError(code: 'x', message: 'nope')));
    await events.close();
    await _settle();

    c.read(chatControllerProvider('c').notifier).consumeRefusedMessage();

    expect(
      c.read(chatControllerProvider('c')).requireValue.refusedMessage,
      isNull,
    );
  });

  test(
    'setModel pins the conversation and applies the returned snapshot',
    () async {
      final events = StreamController<ChatStreamEvent>();
      closeAfterTest(events);
      String? patchedTo;
      final dio = stubDio((o) {
        if (o.method == 'PATCH') {
          patchedTo = (o.data as Map)['defaultModelId'] as String?;
          return jsonResponse({
            'conversation': {'id': 'c'},
            'snapshot': snapshotJson(defaultModelId: 'E2B'),
          });
        }
        return jsonResponse({'snapshot': snapshotJson(defaultModelId: 'E4B')});
      });
      final c = container(events.stream, dio: dio);

      await c.read(chatControllerProvider('c').future);
      expect(c.read(chatControllerProvider('c')).requireValue.modelId, 'E4B');

      await c.read(chatControllerProvider('c').notifier).setModel('E2B');

      // It patches the CONVERSATION, not a global active model.
      expect(patchedTo, 'E2B');
      expect(c.read(chatControllerProvider('c')).requireValue.modelId, 'E2B');
    },
  );

  test('changing the model mid-run does not wipe the streaming reply', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final dio = stubDio((o) {
      if (o.method == 'PATCH') {
        return jsonResponse({
          'conversation': {'id': 'c'},
          'snapshot': snapshotJson(defaultModelId: 'E2B'),
        });
      }
      return jsonResponse({'snapshot': snapshotJson(defaultModelId: 'E4B')});
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(const AssistantDeltaEvent(id: 'm', delta: 'partial answer'));
    await _settle();

    await c.read(chatControllerProvider('c').notifier).setModel('E2B');

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.modelId, 'E2B');
    // The in-flight turn survives: switching models must not eat a streaming reply.
    expect(state.running, isTrue);
    expect(state.pending.last.content, 'partial answer');
  });

  test(
    'setModel is a no-op when the model is already the conversation\'s',
    () async {
      final events = StreamController<ChatStreamEvent>();
      closeAfterTest(events);
      var patches = 0;
      final dio = stubDio((o) {
        if (o.method == 'PATCH') {
          patches++;
        }
        return jsonResponse({'snapshot': snapshotJson(defaultModelId: 'E4B')});
      });
      final c = container(events.stream, dio: dio);
      await c.read(chatControllerProvider('c').future);

      await c.read(chatControllerProvider('c').notifier).setModel('E4B');

      expect(patches, 0);
    },
  );

  test('setReasoningLevel puts the level on the conversation', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    Object? putBody;
    String? putPath;
    final dio = stubDio((o) {
      if (o.method == 'PUT') {
        putPath = o.path;
        putBody = o.data;
        return jsonResponse({
          'snapshot': snapshotJson(reasoningLevel: 'low'),
        });
      }
      return jsonResponse({'snapshot': snapshotJson(reasoningLevel: 'max')});
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);
    expect(
      c.read(chatControllerProvider('c')).requireValue.reasoningLevel,
      ReasoningLevel.max,
    );

    await c
        .read(chatControllerProvider('c').notifier)
        .setReasoningLevel(ReasoningLevel.low);

    // Reasoning is per conversation — it has its own route, not a global setting.
    expect(putPath, '/api/conversations/c/reasoning');
    expect((putBody! as Map)['level'], 'low');
    expect(
      c.read(chatControllerProvider('c')).requireValue.reasoningLevel,
      ReasoningLevel.low,
    );
  });

  test('canReason is a tri-state read straight off the snapshot', () async {
    Future<bool?> canReasonFor(bool? served) async {
      final events = StreamController<ChatStreamEvent>();
      closeAfterTest(events);
      final c = container(
        events.stream,
        dio: stubDio(
          (o) => jsonResponse({'snapshot': snapshotJson(canReason: served)}),
        ),
      );
      await c.read(chatControllerProvider('c').future);
      return c.read(chatControllerProvider('c')).requireValue.canReason;
    }

    // null is "llama.cpp has never loaded this model", NOT "cannot reason".
    expect(await canReasonFor(null), isNull);
    expect(await canReasonFor(false), isFalse);
    expect(await canReasonFor(true), isTrue);
  });

  test('changing reasoning mid-run does not wipe the streaming reply', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final dio = stubDio((o) {
      if (o.method == 'PUT') {
        return jsonResponse({'snapshot': snapshotJson(reasoningLevel: 'off')});
      }
      return jsonResponse({'snapshot': snapshotJson(reasoningLevel: 'max')});
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(const AssistantDeltaEvent(id: 'm', delta: 'partial answer'));
    await _settle();

    await c
        .read(chatControllerProvider('c').notifier)
        .setReasoningLevel(ReasoningLevel.off);

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.reasoningLevel, ReasoningLevel.off);
    // The level applies to the NEXT prompt; the one in flight keeps streaming.
    expect(state.running, isTrue);
    expect(state.pending.last.content, 'partial answer');
  });

  test('a level only a newer server knows is never echoed back', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    var writes = 0;
    final dio = stubDio((o) {
      if (o.method == 'PUT') {
        writes++;
      }
      return jsonResponse({'snapshot': snapshotJson(reasoningLevel: 'max')});
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);

    await c
        .read(chatControllerProvider('c').notifier)
        .setReasoningLevel(ReasoningLevel.$unknown);

    // `$unknown` has no wire value: sending it would throw, and we do not know what
    // it means anyway.
    expect(writes, 0);
  });

  test('a stream error surfaces runError and ends the run', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(
      StreamErrorEvent(
        NelleError(code: 'llama_server_stopped', message: 'not running'),
      ),
    );
    await events.close();
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.running, false);
    expect(state.runError, 'not running');
  });
}
