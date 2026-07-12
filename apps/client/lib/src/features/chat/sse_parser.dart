import 'dart:convert';

import '../../api/chat_stream_event.dart';

/// Parses one SSE frame — its `data:` lines joined and JSON-decoded — into a
/// [ChatStreamEvent], or null for a frame with no data / malformed JSON. A
/// malformed frame is a missing event, never a failed turn.
ChatStreamEvent? parseSseFrame(String frame) {
  if (frame.isEmpty) {
    return null;
  }
  final data = <String>[];
  for (final line in frame.split('\n')) {
    if (line.startsWith('data:')) {
      data.add(line.substring(5).trimLeft());
    }
  }
  if (data.isEmpty) {
    return null;
  }
  try {
    final json = jsonDecode(data.join('\n'));
    if (json is Map<String, dynamic>) {
      return ChatStreamEvent.fromEnvelope(json);
    }
  } catch (_) {
    // Ignore: skip the bad frame.
  }
  return null;
}

/// Splits a UTF-8 byte stream into SSE frames (blank-line delimited, `\r\n`
/// tolerated) and yields the parsed events. Handles frames split across chunks.
Stream<ChatStreamEvent> parseSseByteStream(Stream<List<int>> bytes) async* {
  var buffer = '';
  await for (final chunk in bytes) {
    buffer = '$buffer${utf8.decode(chunk, allowMalformed: true)}'.replaceAll(
      '\r\n',
      '\n',
    );
    int idx;
    while ((idx = buffer.indexOf('\n\n')) != -1) {
      final event = parseSseFrame(buffer.substring(0, idx));
      buffer = buffer.substring(idx + 2);
      if (event != null) {
        yield event;
      }
    }
  }
  final tail = parseSseFrame(buffer.trim());
  if (tail != null) {
    yield tail;
  }
}
