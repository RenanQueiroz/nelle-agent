import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/nelle_error.dart';
import 'package:nelle_agent/src/features/chat/chat_controller.dart';
import 'package:nelle_agent/src/features/chat/slash_commands.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

import '../helpers/fake_dio.dart';

Future<void> _settle() => Future.delayed(const Duration(milliseconds: 20));

void main() {
  late FakeTransport transport;

  ProviderContainer container(Stream<ChatStreamEvent> events, {Dio? dio}) {
    transport = FakeTransport(events);
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          dio ?? stubDio((o) => jsonResponse({'snapshot': snapshotJson()})),
        ),
        sseTransportProvider.overrideWithValue(transport),
      ],
    );
    addTearDown(c.dispose);
    return c;
  }

  group(
    'parseCompactCommand — the client must intercept, the server will not',
    () {
      test('it matches the server helper exactly', () {
        expect(parseCompactCommand('/compact'), '');
        expect(parseCompactCommand('/compact be brief'), 'be brief');
        expect(
          parseCompactCommand('/compact   keep the code  '),
          'keep the code',
        );
        // Ordinary prompts, and near-misses that must NOT be treated as the command.
        expect(parseCompactCommand('compact this'), isNull);
        expect(parseCompactCommand('/compacted'), isNull);
        expect(parseCompactCommand('tell me about /compact'), isNull);
        // Case-sensitive and prefix-exact, like the server's.
        expect(parseCompactCommand('/Compact'), isNull);
      });
    },
  );

  test('compact() streams the compaction endpoint, not the chat one', () async {
    final events = StreamController<ChatStreamEvent>();
    addTearDown(() => unawaited(events.close()));
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).compact('be brief');

    // Sending "/compact" to chat/stream would hand the model the literal text, because
    // the chat route allowlists it and nothing downstream interprets it.
    expect(transport.lastPath, '/api/conversations/c/compact/stream');
    expect((transport.lastBody! as Map)['instructions'], 'be brief');

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.compacting, isTrue);
    expect(state.running, isTrue);
  });

  test('no instructions means no instructions key', () async {
    final events = StreamController<ChatStreamEvent>();
    addTearDown(() => unawaited(events.close()));
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).compact('');

    expect((transport.lastBody! as Map).containsKey('instructions'), isFalse);
  });

  test('the compaction row is synthesized and survives the reload', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).compact('');
    events.add(const CompactStartedEvent(runId: 'r'));
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.compactNote,
      contains('Compacting'),
    );

    events.add(const CompactCompletedEvent(runId: 'r', compacted: true));
    events.add(const RunCompletedEvent(status: 'completed'));
    await events.close();
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    // `buildConversationMessages` drops compaction entries, so the snapshot never
    // carries this row — reloading after the run would erase it if it were not carried
    // across deliberately.
    expect(state.compactNote, 'Conversation compacted.');
    expect(state.compacting, isFalse);
    expect(state.running, isFalse);
  });

  test('a failed compaction surfaces its error', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).compact('');
    events.add(
      CompactFailedEvent(
        runId: 'r',
        error: NelleError(
          code: 'compact_failed',
          message: 'There is no conversation context to compact.',
        ),
      ),
    );
    events.add(const RunCompletedEvent(status: 'failed'));
    await events.close();
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.runError, contains('no conversation context'));
    expect(state.compacting, isFalse);
  });

  test(
    'stopping a compaction prefers the run-scoped abort, which has a warning',
    () async {
      final events = StreamController<ChatStreamEvent>();
      addTearDown(() => unawaited(events.close()));
      final posts = <String>[];
      final c = container(
        events.stream,
        dio: stubDio((o) {
          if (o.method == 'POST') {
            posts.add(o.path);
            return jsonResponse({'ok': true, 'aborted': true});
          }
          return jsonResponse({'snapshot': snapshotJson()});
        }),
      );
      await c.read(chatControllerProvider('c').future);

      await c.read(chatControllerProvider('c').notifier).compact('');
      events.add(const RunStartedEvent(runId: 'run-7', kind: 'compact'));
      await _settle();

      await c.read(chatControllerProvider('c').notifier).abort();

      // `/compact/abort` carries no `warning` field at all; the run-scoped route does, and
      // a llama.cpp slot still processing is worth saying out loud.
      expect(posts, ['/api/conversations/c/runs/run-7/abort']);
    },
  );

  test(
    'a compaction that ends badly does not stay "Compacting…" forever',
    () async {
      final events = StreamController<ChatStreamEvent>();
      final c = container(events.stream);
      await c.read(chatControllerProvider('c').future);

      await c.read(chatControllerProvider('c').notifier).compact('');
      // Pi's real refusal when there is nothing to compact yet.
      events.add(
        StreamErrorEvent(
          NelleError(
            code: 'compact_failed',
            message: 'Nothing to compact (session too small)',
          ),
        ),
      );
      await events.close();
      await _settle();

      final state = c.read(chatControllerProvider('c')).requireValue;
      expect(state.compacting, isFalse);
      // The row said "Compacting conversation context…" and would have said it for the
      // rest of the session. A toast is gone in three seconds; the row is not.
      expect(state.compactNote, 'Nothing to compact (session too small)');
    },
  );
}
