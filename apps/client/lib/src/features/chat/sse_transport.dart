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
    yield* parseSseByteStream(byteStream);
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
