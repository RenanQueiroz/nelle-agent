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
