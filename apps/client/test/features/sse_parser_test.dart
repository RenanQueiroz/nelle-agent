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
