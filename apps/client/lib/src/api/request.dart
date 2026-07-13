import 'dart:convert';

import 'package:dio/dio.dart';

import 'api_exception.dart';

/// Sends a JSON request and turns anything that is not a 2xx into a [NelleApiException].
///
/// Extracted rather than copied. dio is built with `validateStatus: (_) => true` so callers
/// can read `NelleError` bodies off non-2xx responses — which means **a failure does not
/// throw**, and every caller that forgets to check the status parses an error body as a
/// success payload and gets silent nonsense. That check belongs in one place.
Future<Response<Map<String, dynamic>>> sendJson(
  Future<Response<Map<String, dynamic>>> Function() run,
) async {
  final Response<Map<String, dynamic>> res;
  try {
    res = await run();
  } on DioException catch (e) {
    throw NelleApiException.network(e);
  }
  final code = res.statusCode ?? 0;
  if (code < 200 || code >= 300) {
    // A stopped llama.cpp answers 502 here; that is a state, not a crash.
    throw NelleApiException.fromResponse(res);
  }
  return res;
}

/// The receive timeout for a request the *server* may legitimately take a long time over.
///
/// The dio default is 30 s, and that is not a number anyone chose for these: it is simply
/// what everything else needs. But `POST /api/runtime/start` waits up to 30 s for llama.cpp
/// to answer its health probe — a coin flip against the default, to the millisecond — and a
/// Hugging Face search walks eight repositories over the network. Both would fail on a slow
/// day while the server carried happily on, and the client would report an error for an
/// operation that was succeeding.
///
/// dio measures this *between bytes*, so a generous value costs nothing on a healthy call:
/// it only bounds how long a genuinely wedged one hangs before giving up.
const kLongCallTimeout = Duration(minutes: 2);

/// [Options] for one of those calls. Streaming endpoints set their own (an install has no
/// business timing out at all while cmake is linking).
Options longCall() => Options(receiveTimeout: kLongCallTimeout);

/// Sends a request whose **response is bytes**, and turns anything that is not a 2xx into a
/// [NelleApiException].
///
/// The twin of [sendJson], and it exists for the same reason: dio's `validateStatus: (_) => true`
/// means a failure does not throw. But a byte response cannot reuse [sendJson] at all — dio needs
/// `ResponseType.bytes` up front, and on a *failure* the server answers **JSON**, so the error
/// body arrives as raw bytes that `NelleApiException.fromResponse` cannot read. It is decoded
/// here, or the user gets "Request failed" for a refusal the server explained in words.
Future<Response<List<int>>> sendBytes(
  Future<Response<List<int>>> Function() run,
) async {
  final Response<List<int>> res;
  try {
    res = await run();
  } on DioException catch (e) {
    throw NelleApiException.network(e);
  }
  final code = res.statusCode ?? 0;
  if (code < 200 || code >= 300) {
    throw NelleApiException.fromResponse(
      Response<dynamic>(
        requestOptions: res.requestOptions,
        statusCode: code,
        // The failure body is JSON even though we asked for bytes. Hand the decoded error back,
        // or a `conversation_not_found` reads as an empty download.
        data: _decodeJsonBody(res.data),
      ),
    );
  }
  return res;
}

/// The filename the **server** chose, from `content-disposition`.
///
/// Not derived client-side from the title: the server already slugged it, and this is the name
/// the user will see in Files, or Drive, or the mail they send it in. Two clients inventing two
/// names for the same archive is exactly the kind of drift a contract exists to stop.
String? filenameFrom(Headers headers) {
  final disposition = headers.value('content-disposition');
  if (disposition == null) return null;
  final match = RegExp('filename="([^"]+)"').firstMatch(disposition);
  return match?.group(1);
}

/// [Options] for a request that sends **raw bytes as the body**.
///
/// `POST /api/conversations/import` is **not multipart**, unlike `/api/uploads`: it reads the zip
/// straight off `ctx.req.arrayBuffer()`. Sending it as `multipart/form-data` gets
/// `invalid_archive_upload`, which is a confusing thing to debug from the client side.
Options zipUpload() => Options(
  contentType: 'application/zip',
  receiveTimeout: kLongCallTimeout,
);

/// [Options] for a request that expects **raw bytes back**.
Options zipDownload() => Options(
  responseType: ResponseType.bytes,
  receiveTimeout: kLongCallTimeout,
);

Object? _decodeJsonBody(List<int>? bytes) {
  if (bytes == null || bytes.isEmpty) return null;
  try {
    return jsonDecode(utf8.decode(bytes));
  } catch (_) {
    // Not JSON. `fromResponse` falls back to a status-based message, which is the honest answer.
    return null;
  }
}
