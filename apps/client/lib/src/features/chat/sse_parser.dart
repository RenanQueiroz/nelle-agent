import 'dart:convert';

import '../../api/chat_stream_event.dart';

/// Decodes one SSE frame's `data:` lines into their JSON payload, or null for a
/// frame with no data / malformed JSON. A malformed frame is a missing event, never
/// a failed turn.
///
/// Frame *splitting* is shared, but what a payload **means** is not: `chat/stream`
/// sends Nelle envelopes, while llama.cpp's router SSE sends its own shape. So this
/// stops at the JSON and lets each caller map it.
Map<String, dynamic>? parseSseFrameJson(String frame) {
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
      return json;
    }
  } catch (_) {
    // Ignore: skip the bad frame.
  }
  return null;
}

/// One SSE frame of the chat stream, mapped to a [ChatStreamEvent].
ChatStreamEvent? parseSseFrame(String frame) {
  final json = parseSseFrameJson(frame);
  return json == null ? null : ChatStreamEvent.fromEnvelope(json);
}

/// Splits a UTF-8 byte stream into SSE frames (blank-line delimited, `\r\n`
/// tolerated) and yields each frame's JSON payload. Handles frames split across
/// chunks.
Stream<Map<String, dynamic>> parseSseJsonFrames(
  Stream<List<int>> bytes,
) async* {
  var buffer = '';
  await for (final chunk in bytes) {
    buffer = '$buffer${utf8.decode(chunk, allowMalformed: true)}'.replaceAll(
      '\r\n',
      '\n',
    );
    int idx;
    while ((idx = buffer.indexOf('\n\n')) != -1) {
      final json = parseSseFrameJson(buffer.substring(0, idx));
      buffer = buffer.substring(idx + 2);
      if (json != null) {
        yield json;
      }
    }
  }
  final tail = parseSseFrameJson(buffer.trim());
  if (tail != null) {
    yield tail;
  }
}

/// The chat stream: Nelle envelopes -> [ChatStreamEvent].
Stream<ChatStreamEvent> parseSseByteStream(Stream<List<int>> bytes) =>
    parseSseJsonFrames(bytes).map(ChatStreamEvent.fromEnvelope);
