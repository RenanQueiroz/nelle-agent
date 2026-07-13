import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/chat_stream_event.dart';
import '../../api/generated/models/nelle_error.dart';
import 'sse_parser.dart';

/// POSTs a request and yields parsed [ChatStreamEvent]s from the
/// `text/event-stream` response. A pre-stream non-2xx (a 400 body) becomes a
/// [NelleApiException]; in-stream `error` events surface as [StreamErrorEvent].
class SseTransport {
  SseTransport(this._dio);

  final Dio _dio;

  Stream<ChatStreamEvent> stream(
    String path, {
    Object? body,
    CancelToken? cancelToken,
  }) async* {
    final Response<ResponseBody> res;
    try {
      res = await _dio.post<ResponseBody>(
        path,
        data: body,
        options: Options(
          responseType: ResponseType.stream,
          receiveTimeout: const Duration(minutes: 10),
          headers: const {'accept': 'text/event-stream'},
        ),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) return;
      throw NelleApiException.network(e);
    }

    final byteStream = res.data!.stream;
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw _errorFromBody(await _collect(byteStream), code);
    }
    yield* parseSseByteStream(_endOnCancel(byteStream));
  }

  /// Opens an SSE endpoint and yields each frame's **raw JSON payload**.
  ///
  /// Two callers, and they are not the same shape:
  /// - llama.cpp's router events (`GET /api/llama/models/events`), which the server pipes
  ///   straight through — they are *not* Nelle envelopes, so they must never go through
  ///   [ChatStreamEvent.fromEnvelope];
  /// - the install stream (`POST /api/runtime/install/stream`), which *is* a Nelle envelope
  ///   but carries `RuntimeInstallEvent`, not `ChatStreamEvent`.
  ///
  /// Only the frame-splitting is shared. Each caller parses its own events, because feeding
  /// one of these shapes to the other's parser mis-reads every frame.
  Stream<Map<String, dynamic>> streamJson(
    String path, {
    String method = 'GET',
    Object? body,
    CancelToken? cancelToken,
  }) async* {
    final Response<ResponseBody> res;
    try {
      res = await _dio.request<ResponseBody>(
        path,
        data: body,
        options: Options(
          method: method,
          responseType: ResponseType.stream,
          // No receive timeout at all. The router is quiet between loads, and an install is
          // quiet while cmake links — a timeout here would kill a stream that is perfectly
          // healthy and merely thinking.
          receiveTimeout: Duration.zero,
          headers: const {'accept': 'text/event-stream'},
        ),
        cancelToken: cancelToken,
      );
    } on DioException catch (e) {
      if (CancelToken.isCancel(e)) return;
      throw NelleApiException.network(e);
    }

    final byteStream = res.data!.stream;
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      // llama.cpp is not running: 502. The caller retries; it is not a crash.
      throw _errorFromBody(await _collect(byteStream), code);
    }
    yield* parseSseJsonFrames(_endOnCancel(byteStream));
  }

  Future<String> _collect(Stream<Uint8List> byteStream) async {
    final buffer = StringBuffer();
    await for (final chunk in byteStream) {
      buffer.write(utf8.decode(chunk, allowMalformed: true));
    }
    return buffer.toString();
  }

  NelleApiException _errorFromBody(String body, int code) {
    try {
      final json = jsonDecode(body);
      if (json is Map && json['error'] is Map) {
        final error = NelleError.fromJson(
          (json['error'] as Map).cast<String, Object?>(),
        );
        return NelleApiException(
          error.message,
          code: error.code,
          statusCode: code,
        );
      }
    } catch (_) {
      // Fall through to the generic message.
    }
    return NelleApiException('Request failed ($code)', statusCode: code);
  }
}

final sseTransportProvider = Provider<SseTransport>(
  (ref) => SseTransport(ref.watch(dioProvider)),
);

/// A cancelled SSE stream has **ended**, not failed.
///
/// The `try/catch` in each method above covers only the *request*. Once the stream is open,
/// cancelling its token makes dio `addErrorAndClose` the underlying byte stream — and a listener
/// that has already been cancelled cannot catch that, so it escapes as an **unhandled**
/// `DioException [request cancelled]`.
///
/// That is not hypothetical. Both SSE notifiers dispose in this order:
///
/// ```dart
/// _sub?.cancel();     // the listener goes first...
/// _cancel?.cancel();  // ...and *then* dio errors the stream, with nobody left to hear it
/// ```
///
/// which is every provider dispose — including a **connection change**, when the user pairs,
/// unpairs, or is revoked. In the app it was invisible, which is why it survived eight milestones;
/// the M9 device suite fails on unhandled zone errors, and that is what surfaced it.
///
/// The filter is deliberately narrow: a *real* fault mid-stream (a dropped connection) must still
/// reach the caller, or it would look like a stream that simply ended and the notifier would never
/// reattach. Only a cancellation is swallowed — because that is what cancelling asked for.
Stream<T> _endOnCancel<T>(Stream<T> stream) => stream.handleError(
  (Object _) {},
  test: (error) => error is DioException && CancelToken.isCancel(error),
);
