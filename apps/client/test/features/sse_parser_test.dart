import 'package:nelle_agent/src/features/chat/sse_transport.dart';
import '../helpers/fake_dio.dart';
import 'dart:async';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/features/chat/sse_parser.dart';

String frame(Map<String, dynamic> data) {
  final type = data['type'];
  return 'id: e\nevent: $type\ndata: ${jsonEncode({'id': 'e', 'type': type, 'data': data})}\n\n';
}

Map<String, dynamic> delta(String d) => {
  'type': 'message.assistant.delta',
  'id': 'm',
  'delta': d,
  'isReasoning': false,
};

void main() {
  _cancellationTests();
  _cancellationTests();
  group('parseSseFrame', () {
    test('reads the data line', () {
      final event = parseSseFrame(
        'id: e\nevent: error\ndata: {"type":"error","code":"x","message":"m"}',
      );
      expect(event, isA<StreamErrorEvent>());
    });

    test('ignores comments, empty frames, and data-less frames', () {
      expect(parseSseFrame(''), isNull);
      expect(parseSseFrame(': keep-alive'), isNull);
      expect(parseSseFrame('event: ping'), isNull);
    });

    test('ignores malformed JSON rather than throwing', () {
      expect(parseSseFrame('data: {not json'), isNull);
    });
  });

  group('parseSseByteStream', () {
    test('splits multiple frames in one chunk', () async {
      final bytes = Stream.value(
        utf8.encode('${frame(delta('a'))}${frame(delta('b'))}'),
      );
      final events = await parseSseByteStream(bytes).toList();
      expect(events.map((e) => (e as AssistantDeltaEvent).delta), ['a', 'b']);
    });

    test('reassembles a frame split across chunks', () async {
      final full = frame({'type': 'run.completed', 'status': 'completed'});
      final mid = full.length ~/ 2;
      final bytes = Stream.fromIterable([
        utf8.encode(full.substring(0, mid)),
        utf8.encode(full.substring(mid)),
      ]);
      final events = await parseSseByteStream(bytes).toList();
      expect(events.single, isA<RunCompletedEvent>());
    });

    test('tolerates CRLF line endings', () async {
      final crlf = 'data: {"type":"error","code":"x","message":"m"}\r\n\r\n';
      final events = await parseSseByteStream(
        Stream.value(utf8.encode(crlf)),
      ).toList();
      expect(events.single, isA<StreamErrorEvent>());
    });

    test('flushes a trailing frame with no blank line', () async {
      final noTrailingBlank = 'data: {"type":"run.aborted","reason":"user"}';
      final events = await parseSseByteStream(
        Stream.value(utf8.encode(noTrailingBlank)),
      ).toList();
      expect(events.single, isA<RunAbortedEvent>());
    });
  });
}

/// **A cancelled SSE stream has ENDED, not failed** — driven through the real [SseTransport].
///
/// The transport's `try/catch` covers only the *request*. Once the stream is open, cancelling its
/// token makes dio `addErrorAndClose` the byte stream — and both SSE notifiers dispose `_sub` before
/// `_cancel`, so the listener is already gone when that error lands and it escapes the zone as an
/// unhandled `DioException [request cancelled]`. That is every provider dispose, including a
/// connection change.
///
/// It was invisible in the app for eight milestones; the M9 device suite, which fails on unhandled
/// zone errors, is what finally surfaced it. So this drives the **real** transport over a stubbed
/// adapter — asserting against a local copy of the filter would only test the copy.
void _cancellationTests() {
  /// A transport whose response body is a stream this test drives — including erroring it the way
  /// dio does when a `CancelToken` is cancelled mid-stream.
  (SseTransport, StreamController<Uint8List>) transportOverStream() {
    final controller = StreamController<Uint8List>();
    final dio = Dio(BaseOptions(baseUrl: 'http://localhost'))
      ..httpClientAdapter = StubAdapter(
        (_) => ResponseBody(
          controller.stream,
          200,
          headers: {
            Headers.contentTypeHeader: ['text/event-stream'],
          },
        ),
      );
    return (SseTransport(dio), controller);
  }

  test('a cancellation ends the stream instead of escaping as an error', () async {
    final (transport, controller) = transportOverStream();

    final frames = <String>[];
    Object? escaped;
    final sub = transport
        .streamJson('/api/llama/models/events')
        .listen(
          (frame) => frames.add(frame['event'] as String),
          onError: (Object e) => escaped = e,
        );

    await Future<void>.delayed(const Duration(milliseconds: 20));
    controller.add(
      Uint8List.fromList(utf8.encode('data: {"event":"status_change"}\n\n')),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));

    // Exactly what dio does to an open response stream when its token is cancelled.
    controller.addError(
      DioException.requestCancelled(
        requestOptions: RequestOptions(path: '/api/llama/models/events'),
        reason: 'cancelled',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await sub.cancel();

    expect(frames, ['status_change'], reason: 'frames before the cancel still arrive');
    expect(
      escaped,
      isNull,
      reason: 'a cancellation is what the caller ASKED for; it is not an error to report',
    );
  });

  test('a real network fault mid-stream is STILL an error', () async {
    // The filter is narrow on purpose. A dropped connection must still reach the caller, or it
    // would look like a stream that simply ended — and the notifier would never reattach.
    final (transport, controller) = transportOverStream();

    Object? escaped;
    final sub = transport
        .streamJson('/api/llama/models/events')
        .listen((_) {}, onError: (Object e) => escaped = e);

    await Future<void>.delayed(const Duration(milliseconds: 20));
    controller.addError(
      DioException.connectionError(
        requestOptions: RequestOptions(path: '/api/llama/models/events'),
        reason: 'the network went away',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 20));
    await sub.cancel();

    expect(escaped, isA<DioException>());
  });
}
