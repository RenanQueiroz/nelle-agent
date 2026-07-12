import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

/// An [SseTransport] that replays caller-controlled streams instead of making real
/// streamed requests: [ChatStreamEvent]s for the chat stream, and raw JSON frames
/// for llama.cpp's router events.
class FakeTransport extends SseTransport {
  // `jsonEvents` is public because Dart forbids a private named parameter, so an
  // initializing formal is only possible on a public field.
  FakeTransport(this._events, {this.jsonEvents}) : super(Dio());

  final Stream<ChatStreamEvent> _events;
  final Stream<Map<String, dynamic>>? jsonEvents;

  @override
  Stream<ChatStreamEvent> stream(
    String path, {
    Object? body,
    CancelToken? cancelToken,
  }) => _events;

  @override
  Stream<Map<String, dynamic>> streamJson(
    String path, {
    CancelToken? cancelToken,
  }) => jsonEvents ?? const Stream.empty();
}

/// A dio adapter that returns canned responses, so repository tests never touch
/// the network.
class StubAdapter implements HttpClientAdapter {
  StubAdapter(this.responder);

  final ResponseBody Function(RequestOptions options) responder;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => responder(options);
}

ResponseBody jsonResponse(Object body, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

Dio stubDio(ResponseBody Function(RequestOptions options) responder) {
  final dio = Dio(
    BaseOptions(baseUrl: 'http://test.local', validateStatus: (_) => true),
  );
  dio.httpClientAdapter = StubAdapter(responder);
  return dio;
}

/// A minimal but complete conversation snapshot JSON for tests.
Map<String, dynamic> snapshotJson({
  List<Map<String, dynamic>> messages = const [],
}) => {
  'conversation': {
    'id': 'c',
    'title': 'Test chat',
    'titleSource': 'user',
    'pinned': false,
    'status': 'ready',
    'createdAt': 't',
    'updatedAt': 't',
    'reasoningLevel': 'max',
  },
  'entries': <Map<String, dynamic>>[],
  'messages': messages,
  'activePathEntryIds': <String>[],
  'attachments': <Map<String, dynamic>>[],
  'context': {'status': 'ok'},
  'models': {'available': <Map<String, dynamic>>[]},
  'capabilities': {
    'canSend': true,
    'canAbort': true,
    'canCompact': true,
    'canFork': true,
    'canRepair': false,
    'canAttachImages': null,
    'canReason': null,
  },
  'errors': <Map<String, dynamic>>[],
};
