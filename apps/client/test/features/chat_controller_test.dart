import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/nelle_error.dart';
import 'package:nelle_agent/src/features/chat/chat_controller.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

import '../helpers/fake_dio.dart';

Future<void> _settle() => Future.delayed(const Duration(milliseconds: 20));

void main() {
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
    addTearDown(events.close);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hello');

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.running, true);
    expect(state.pending.map((m) => m.content), ['hello', '']);
  });

  test('folds content and reasoning deltas into the assistant turn', () async {
    final events = StreamController<ChatStreamEvent>();
    addTearDown(events.close);
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
    addTearDown(events.close);
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
