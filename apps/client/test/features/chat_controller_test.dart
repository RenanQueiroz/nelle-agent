import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/api/generated/models/chat_performance.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_list_item_title_source.dart';
import 'package:nelle_agent/src/api/generated/models/nelle_error.dart';
import 'package:nelle_agent/src/api/generated/models/nelle_warning.dart';
import 'package:nelle_agent/src/api/generated/models/reasoning_level.dart';
import 'package:nelle_agent/src/api/generated/models/tool_call_event.dart';
import 'package:nelle_agent/src/api/generated/models/tool_call_event_status.dart';
import 'package:nelle_agent/src/features/attachments/attachment_draft.dart';
import 'package:nelle_agent/src/features/chat/chat_controller.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import 'package:nelle_agent/src/features/conversations/conversations_notifier.dart';

import '../helpers/fake_dio.dart';

Future<void> _settle() => Future.delayed(const Duration(milliseconds: 20));

/// The filename inside a multipart upload, so the stub can echo it back as an id.
String _filenameOf(Object? data) =>
    data is FormData ? (data.files.first.value.filename ?? 'file') : 'file';

void main() {
  /// Closes [events] after the test, dropping the future `close()` returns.
  ///
  /// A single-subscription controller nothing ever listened to never completes its
  /// `close()`, and `addTearDown` awaits what it is handed — so a test that never
  /// sends (and so never subscribes to the stream) would hang instead of finishing.
  void closeAfterTest(StreamController<ChatStreamEvent> events) =>
      addTearDown(() => unawaited(events.close()));

  late FakeTransport transport;

  ProviderContainer container(Stream<ChatStreamEvent> events, {Dio? dio}) {
    transport = FakeTransport(events);
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          dio ??
              stubDio((o) {
                // Staging an attachment really uploads it, so the harness has to answer
                // for the upload route too. The id is derived from the filename, so a
                // test can name what it expects on the wire.
                if (o.path == '/api/uploads') {
                  final name = _filenameOf(o.data);
                  return jsonResponse({
                    'uploadId': 'u-$name',
                    'kind': 'text',
                    'name': name,
                    'sizeBytes': 1,
                    'warnings': <String>[],
                  }, status: 201);
                }
                return jsonResponse({'snapshot': snapshotJson()});
              }),
        ),
        sseTransportProvider.overrideWithValue(transport),
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

  test('a downloading phase carries its bytes through to the state', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');

    // A first load *downloads* the weights before anything can load; the server names the
    // phase and counts the bytes, and the state must not flatten that back to a bare spinner.
    events.add(
      const ModelLoadingEvent(
        modelId: 'm',
        status: 'downloading',
        phase: 'downloading',
        downloadedBytes: 750,
        totalBytes: 1500,
        progress: 0.5,
      ),
    );
    await _settle();

    final load = c.read(chatControllerProvider('c')).requireValue.modelLoad;
    expect(load?.downloading, isTrue);
    expect(load?.downloadedBytes, 750);
    expect(load?.totalBytes, 1500);
    expect(load?.progress, 0.5);
  });

  test('tool_call.updated upserts into liveToolCalls by id', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('use a tool');

    events.add(
      ToolCallUpdatedEvent(
        ToolCallEvent(
          id: 't1',
          name: 'read_file',
          status: ToolCallEventStatus.running,
        ),
      ),
    );
    await _settle();
    var calls = c.read(chatControllerProvider('c')).requireValue.liveToolCalls;
    expect(calls.single.status, ToolCallEventStatus.running);

    // The same call completes — upserted in place, not appended.
    events.add(
      ToolCallUpdatedEvent(
        ToolCallEvent(
          id: 't1',
          name: 'read_file',
          status: ToolCallEventStatus.complete,
          output: 'done',
        ),
      ),
    );
    await _settle();
    calls = c.read(chatControllerProvider('c')).requireValue.liveToolCalls;
    expect(calls, hasLength(1));
    expect(calls.single.status, ToolCallEventStatus.complete);
    expect(calls.single.output, 'done');
  });

  test('performance.updated folds into livePerformance, per token', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');

    // Reading phase: prompt metrics tick, no generation yet.
    events.add(
      PerformanceUpdatedEvent(
        id: 'a',
        performance: ChatPerformance.fromJson(const {
          'source': 'llamacpp-timings',
          'prompt': {'tokens': 171, 'milliseconds': 504.4},
        }),
      ),
    );
    await _settle();
    var live = c.read(chatControllerProvider('c')).requireValue.livePerformance;
    expect(live?.prompt?.tokens, 171);
    expect(live?.generation, isNull);

    // Generation phase: a later frame carries both.
    events.add(
      PerformanceUpdatedEvent(
        id: 'a',
        performance: ChatPerformance.fromJson(const {
          'source': 'llamacpp-timings',
          'prompt': {'tokens': 171, 'milliseconds': 504.4},
          'generation': {
            'tokens': 16,
            'milliseconds': 246,
            'tokensPerSecond': 65.0,
          },
        }),
      ),
    );
    await _settle();
    live = c.read(chatControllerProvider('c')).requireValue.livePerformance;
    expect(live?.generation?.tokens, 16);
    expect(live?.generation?.tokensPerSecond, 65.0);
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

  test('a generated title updates the sidebar row and the chat header live', () async {
    // The reported bug: a fresh chat sat at "New chat" for the whole session. The server
    // generates the title *after* run.completed and streams it as `conversation.updated` on the
    // same stream — which the controller used to cancel on run.completed, dropping the event and
    // leaving the sidebar (loaded once, never re-fetched) stuck on its creation-time title.
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final dio = stubDio((o) {
      if (o.method == 'GET' && o.path == '/api/conversations') {
        return jsonResponse({
          'conversations': [
            {
              'id': 'c',
              'title': 'New chat',
              'titleSource': 'fallback',
              'pinned': false,
              'status': 'ready',
              'updatedAt': 't',
            },
          ],
          'total': 1,
        });
      }
      return jsonResponse({'snapshot': snapshotJson()});
    });
    final c = container(events.stream, dio: dio);

    // The sidebar has loaded the fresh chat's fallback title.
    await c.read(conversationsProvider.future);
    expect(
      c.read(conversationsProvider).requireValue.items.single.title,
      'New chat',
    );

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');
    // The visible run finishes; crucially the stream is NOT cancelled here.
    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.running,
      isFalse,
      reason: 'the visible run is over even though the stream is held open',
    );

    // The title arrives on that still-open stream, from the title sub-run.
    events.add(const ConversationUpdatedEvent(title: 'One word greeting'));
    await _settle();

    final row = c.read(conversationsProvider).requireValue.items.single;
    expect(row.title, 'One word greeting');
    expect(row.titleSource, ConversationListItemTitleSource.generated);
    // The chat header updates live too, without re-opening the conversation.
    expect(
      c.read(chatControllerProvider('c')).requireValue.title,
      'One word greeting',
    );
  });

  test('the title sub-run\'s own run events do not re-finalize the run', () async {
    // After the visible run completes the server streams a short title sub-run with its OWN
    // run.started/run.completed. Those must be ignored — folding them would clear the model
    // claim twice or reload the snapshot again.
    var gets = 0;
    final dio = stubDio((o) {
      if (o.method == 'GET' && o.path == '/api/conversations') {
        return jsonResponse({'conversations': <Object>[], 'total': 0});
      }
      if (o.method == 'GET') gets++;
      return jsonResponse({'snapshot': snapshotJson()});
    });
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream, dio: dio);

    await c.read(chatControllerProvider('c').future);
    final getsAfterBuild = gets; // the initial snapshot load
    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();
    final getsAfterFinalize = gets; // one reload on the visible completion

    // The title sub-run's frames arrive on the kept-open stream.
    events.add(const RunStartedEvent(runId: 'title-run'));
    events.add(const ConversationUpdatedEvent(title: 'Titled'));
    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();

    expect(
      gets,
      getsAfterFinalize,
      reason: 'the title sub-run must not trigger another snapshot reload',
    );
    expect(getsAfterFinalize, getsAfterBuild + 1);
    expect(c.read(chatControllerProvider('c')).requireValue.running, isFalse);
  });

  test(
    'a failed run cancels the stream instead of waiting for a title',
    () async {
      // A failure sends no title, so keeping the stream open would just hang. The run must end
      // immediately, exactly as before.
      final events = StreamController<ChatStreamEvent>();
      closeAfterTest(events);
      final c = container(events.stream);

      await c.read(chatControllerProvider('c').future);
      await c.read(chatControllerProvider('c').notifier).send('hi');
      events.add(const RunStartedEvent(runId: 'r'));
      events.add(const RunCompletedEvent(status: 'failed'));
      await _settle();

      final state = c.read(chatControllerProvider('c')).requireValue;
      expect(state.running, isFalse);
      expect(state.runError, 'The run failed.');
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
      // Send-blocking: the persistent banner above the composer, never the toast —
      // a toast vanishes while the reason still applies.
      expect(state.sendError, 'not running');
      expect(state.runError, isNull);
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
    // A run that started is a run outcome — the toast, not the composer banner.
    expect(state.sendError, isNull);
  });

  test('the next send clears the send-blocking banner', () async {
    // Broadcast, because this test sends twice and each send subscribes anew — a
    // single-subscription stream would throw on the second listen.
    final events = StreamController<ChatStreamEvent>.broadcast();
    final c = container(events.stream);

    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('first');
    events.add(
      StreamErrorEvent(
        NelleError(code: 'llama_server_stopped', message: 'not running'),
      ),
    );
    await events.close();
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.sendError,
      'not running',
    );

    // The reason may still apply, but the user is retrying: the stale sentence must
    // not sit beside the new attempt's outcome.
    await c.read(chatControllerProvider('c').notifier).send('second');
    expect(c.read(chatControllerProvider('c')).requireValue.sendError, isNull);
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

  test('regenerate streams a new answer and keeps the old one', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    var gets = 0;
    final dio = stubDio((o) {
      gets++;
      return jsonResponse({
        'snapshot': snapshotJson(
          messages: [
            {'id': 'u1', 'role': 'user', 'content': 'hi', 'createdAt': 't'},
            {
              'id': 'a1',
              'role': 'assistant',
              'content': 'first answer',
              'createdAt': 't',
              // After the regenerate the server groups both answers as variants.
              if (gets > 1) 'variantLabel': 'variant 1/2',
            },
            // The reload after the run returns the new answer beside the old one.
            if (gets > 1)
              {
                'id': 'a2',
                'role': 'assistant',
                'content': 'second answer',
                'createdAt': 't',
                'variantLabel': 'variant 2/2',
              },
          ],
        ),
      });
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).regenerate('a1');

    expect(transport.lastPath, '/api/conversations/c/messages/a1/regenerate');
    // No override: the conversation's own model answers.
    expect((transport.lastBody! as Map).containsKey('modelId'), isFalse);

    var state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.running, isTrue);
    // The old answer stays on screen while the new one streams beneath it.
    expect(state.messages.map((m) => m.content), contains('first answer'));
    expect(state.pending, hasLength(1));

    events.add(const AssistantDeltaEvent(id: 'a2', delta: 'second answer'));
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.pending.last.content,
      'second answer',
    );

    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();

    state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.running, isFalse);
    expect(state.pending, isEmpty);
    // Both answers survive, and the server labels them.
    expect(state.messages.map((m) => m.content), [
      'hi',
      'first answer',
      'second answer',
    ]);
    expect(state.messages.last.variantLabel, 'variant 2/2');
  });

  test('regenerate can override the model for one answer', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c
        .read(chatControllerProvider('c').notifier)
        .regenerate('a1', modelId: 'E2B');

    expect((transport.lastBody! as Map)['modelId'], 'E2B');
  });

  test('a refused regenerate is not handed back to the composer', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).regenerate('a1');
    events.add(
      StreamErrorEvent(
        NelleError(code: 'llama_server_stopped', message: 'not running'),
      ),
    );
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    // There is no typed message to give back: the turn is already in the transcript.
    expect(state.refusedMessage, isNull);
    // Refused before anything ran, so it is send-blocking: the persistent banner,
    // not the toast.
    expect(state.sendError, 'not running');
    expect(state.runError, isNull);
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
        return jsonResponse({'snapshot': snapshotJson(reasoningLevel: 'low')});
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

  test(
    'activateVariant posts to the activate route and applies the snapshot',
    () async {
      final events = StreamController<ChatStreamEvent>();
      closeAfterTest(events);
      String? activatedPath;
      final dio = stubDio((o) {
        if (o.method == 'POST' && o.path.contains('/activate')) {
          activatedPath = o.path;
          return jsonResponse({
            'snapshot': snapshotJson(
              messages: [
                {
                  'id': 'a2',
                  'role': 'assistant',
                  'content': 'the older variant',
                  'createdAt': 't',
                },
              ],
            ),
          });
        }
        return jsonResponse({'snapshot': snapshotJson()});
      });
      final c = container(events.stream, dio: dio);
      await c.read(chatControllerProvider('c').future);

      await c.read(chatControllerProvider('c').notifier).activateVariant('a2');

      expect(activatedPath, '/api/conversations/c/messages/a2/activate');
      expect(
        c
            .read(chatControllerProvider('c'))
            .requireValue
            .messages
            .map((m) => m.content),
        contains('the older variant'),
      );
    },
  );

  test('activateVariant is refused mid-run', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    var activateCalls = 0;
    final dio = stubDio((o) {
      if (o.path.contains('/activate')) {
        activateCalls++;
      }
      return jsonResponse({'snapshot': snapshotJson()});
    });
    final c = container(events.stream, dio: dio);
    await c.read(chatControllerProvider('c').future);
    await c
        .read(chatControllerProvider('c').notifier)
        .send('hi'); // now running

    await c.read(chatControllerProvider('c').notifier).activateVariant('a2');

    expect(
      activateCalls,
      0,
      reason: 'the transcript must not change under a streaming reply',
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

  test('attachments are sent as {uploadId} and nothing else', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    // Two staged uploads — the bytes went to the server when they were staged.
    await c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(bytes: Uint8List.fromList([1]), filename: 'a.txt');
    await c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(bytes: Uint8List.fromList([2]), filename: 'b.txt');

    await c.read(chatControllerProvider('c').notifier).send('look at these');

    // `chatRequestSchema` is `.strict()` at both levels: an old client embedding `text`
    // or `data`, or asking for a rendering mode, is refused by name.
    final body = transport.lastBody! as Map;
    expect(body['message'], 'look at these');
    expect(body['attachments'], [
      {'uploadId': 'u-a.txt'},
      {'uploadId': 'u-b.txt'},
    ]);
  });

  test('a message with no attachments sends no attachments key', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);

    await c.read(chatControllerProvider('c').notifier).send('just text');

    expect((transport.lastBody! as Map).containsKey('attachments'), isFalse);
  });

  test('run.started clears the draft: the uploads are a message now', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);
    await c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(bytes: Uint8List.fromList([1]), filename: 'a.txt');

    await c.read(chatControllerProvider('c').notifier).send('here');
    expect(c.read(attachmentDraftProvider('c')).uploads, hasLength(1));

    events.add(const RunStartedEvent(runId: 'r'));
    await _settle();

    expect(c.read(attachmentDraftProvider('c')).uploads, isEmpty);
  });

  test('a refused message keeps its chips as well as its text', () async {
    final events = StreamController<ChatStreamEvent>();
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);
    await c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(bytes: Uint8List.fromList([1]), filename: 'scan.pdf');

    await c.read(chatControllerProvider('c').notifier).send('read this');
    // No `run.started`: the server refused it before it became a turn.
    events.add(
      StreamErrorEvent(
        NelleError(
          code: 'unsupported_attachment',
          message: 'scan.pdf has no text layer.',
        ),
      ),
    );
    await events.close();
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.refusedMessage, 'read this');
    // Send-blocking, so it lands on the composer banner and stays there.
    expect(state.sendError, contains('scan.pdf'));
    // The uploads are still on the server, unbound. Making the user pick the files
    // again is not a fix.
    expect(c.read(attachmentDraftProvider('c')).uploads, hasLength(1));
  });

  test(
    'a stream error after run.started surfaces runError and ends the run',
    () async {
      final events = StreamController<ChatStreamEvent>();
      final c = container(events.stream);

      await c.read(chatControllerProvider('c').future);
      await c.read(chatControllerProvider('c').notifier).send('hi');
      // The run started, so this is a run outcome — the toast path, not the banner.
      events.add(const RunStartedEvent(runId: 'r'));
      events.add(
        StreamErrorEvent(
          NelleError(code: 'pi_run_failed', message: 'it broke mid-answer'),
        ),
      );
      await events.close();
      await _settle();

      final state = c.read(chatControllerProvider('c')).requireValue;
      expect(state.running, false);
      expect(state.runError, 'it broke mid-answer');
      expect(state.sendError, isNull);
    },
  );

  test('a run warning is surfaced, not swallowed', () async {
    final events = StreamController<ChatStreamEvent>();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');

    // Not an error: the run completes. But an answer that stops mid-sentence because
    // the reply budget ran out is not something to leave the user staring at.
    events.add(
      RunWarningEvent(
        NelleWarning(
          code: 'reply_budget_exhausted',
          message: 'The prompt left no room for a reply.',
        ),
      ),
    );
    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();

    final state = c.read(chatControllerProvider('c')).requireValue;
    expect(state.runWarning, 'The prompt left no room for a reply.');
    // A warning is not an error: the run did not fail.
    expect(state.runError, isNull);
    expect(state.running, isFalse);
  });

  test('the next send clears the previous warning', () async {
    // Broadcast, because this test sends twice and the fake transport hands back the
    // same stream each time.
    final events = StreamController<ChatStreamEvent>.broadcast();
    closeAfterTest(events);
    final c = container(events.stream);
    await c.read(chatControllerProvider('c').future);
    await c.read(chatControllerProvider('c').notifier).send('hi');
    events.add(
      RunWarningEvent(
        NelleWarning(code: 'reply_budget_exhausted', message: 'no room'),
      ),
    );
    events.add(const RunCompletedEvent(status: 'completed'));
    await _settle();
    expect(
      c.read(chatControllerProvider('c')).requireValue.runWarning,
      'no room',
    );

    // The warning belongs to the run that raised it, not to the conversation.
    await c.read(chatControllerProvider('c').notifier).send('again');

    expect(c.read(chatControllerProvider('c')).requireValue.runWarning, isNull);
  });
}
