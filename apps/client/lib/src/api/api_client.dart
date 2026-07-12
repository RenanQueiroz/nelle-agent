import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/connection/auth_interceptor.dart';
import '../features/connection/pinned_adapter.dart';
import '../features/connection/server_connection.dart';
import '../features/connection/secure_storage.dart';
import 'generated/models/issued_tokens.dart';

/// A dio client bound to the current [ServerConnection], rebuilt when it changes.
///
/// Non-2xx responses are **returned rather than thrown** (`validateStatus: (_) => true`)
/// so callers can read `NelleError` bodies off the wire. That single line is why
/// [AuthInterceptor] renews the token in `onResponse` and not in `onError`: dio routes
/// every response, 401 included, to the success path. An interceptor written the
/// textbook way would never run.
final dioProvider = Provider<Dio>((ref) {
  final connection = ref.watch(connectionProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: connection.baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      validateStatus: (_) => true,
      headers: const {'accept': 'application/json'},
    ),
  );

  // Trusts exactly one self-signed certificate, and nothing else. `null` on loopback
  // (nothing to pin) and on the web (a browser will not let anyone pin).
  final adapter = pinnedAdapter(connection.certFingerprint);
  if (adapter != null) {
    dio.httpClientAdapter = adapter;
  }

  // Loopback is trusted by the server because arriving there is proof of local access,
  // so it must carry no bearer at all -- attaching one would be noise at best, and at
  // worst a token where none belongs.
  if (connection.isPaired) {
    dio.interceptors.add(
      AuthInterceptor(
        tokenStore: ref.read(tokenStoreProvider),
        retry: dio.fetch,
        onAuthLost: () => ref.read(connectionProvider.notifier).unpair(),
        refreshTokens: (refreshToken) => _refresh(dio, refreshToken),
      ),
    );
  }

  ref.onDispose(dio.close);
  return dio;
});

/// Exchanges the refresh token for a new pair. `null` means the server refused it --
/// the device has been revoked, or its tokens were rotated out from under it.
///
/// Uses the same dio instance deliberately: it carries the pinned adapter, and a
/// refresh must be pinned like everything else. The route is on the server's auth
/// allowlist, so the interceptor leaves it alone and cannot recurse into itself.
Future<IssuedTokens?> _refresh(Dio dio, String refreshToken) async {
  try {
    final response = await dio.post<Map<String, Object?>>(
      '/api/auth/refresh',
      data: {'refreshToken': refreshToken},
    );
    final status = response.statusCode ?? 0;
    // A non-2xx does not throw here, so the body must not be believed before the
    // status is checked: parsing an error body as tokens yields silent nonsense.
    if (status < 200 || status >= 300 || response.data == null) {
      return null;
    }
    return IssuedTokens.fromJson(response.data!);
  } on DioException {
    // The network is gone, or the certificate did not match the pin. Either way we
    // have no tokens; the caller decides whether that means "unpair" or "retry later".
    return null;
  }
}
