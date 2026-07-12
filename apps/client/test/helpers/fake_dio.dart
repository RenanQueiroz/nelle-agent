import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';
import 'package:nelle_agent/src/features/chat/sse_transport.dart';

/// An [SseTransport] that replays caller-controlled streams instead of making real
/// streamed requests: [ChatStreamEvent]s for the chat stream, and raw JSON frames
/// for llama.cpp's router events.
class FakeTransport extends SseTransport {
  // These are public because Dart forbids a private named parameter, so an
  // initializing formal is only possible on a public field.
  FakeTransport(this._events, {this.jsonEvents, this.jsonEventsBuilder})
    : super(Dio());

  final Stream<ChatStreamEvent> _events;
  final Stream<Map<String, dynamic>>? jsonEvents;

  /// Supplies a **fresh** stream per call, so a reattach after llama.cpp drops can be
  /// tested — re-listening to a single-subscription stream would just throw.
  final Stream<Map<String, dynamic>> Function()? jsonEventsBuilder;

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
  }) => jsonEventsBuilder?.call() ?? jsonEvents ?? const Stream.empty();
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
  String? defaultModelId,
  List<Map<String, dynamic>> available = const [],
  String reasoningLevel = 'max',
  bool? canReason,
}) => {
  'conversation': {
    'id': 'c',
    'title': 'Test chat',
    'titleSource': 'user',
    'pinned': false,
    'status': 'ready',
    'createdAt': 't',
    'updatedAt': 't',
    'reasoningLevel': reasoningLevel,
    'defaultModelId': ?defaultModelId,
  },
  'entries': <Map<String, dynamic>>[],
  'messages': messages,
  'activePathEntryIds': <String>[],
  'attachments': <Map<String, dynamic>>[],
  'context': {'status': 'ok'},
  'models': {'available': available, 'defaultModelId': ?defaultModelId},
  'capabilities': {
    'canSend': true,
    'canAbort': true,
    'canCompact': true,
    'canFork': true,
    'canRepair': false,
    'canAttachImages': null,
    'canReason': canReason,
  },
  'errors': <Map<String, dynamic>>[],
};
