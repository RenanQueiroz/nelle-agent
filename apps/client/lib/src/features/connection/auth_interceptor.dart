import 'package:dio/dio.dart';

import '../../api/generated/models/issued_tokens.dart';
import 'token_store.dart';

/// Paths a device may call without a token — and must, because they are how it gets
/// one. Mirrors the server's own `AUTH_ALLOWLIST`; a 401 from one of these is a real
/// answer ("that refresh token is dead"), never a prompt to refresh.
const _authExemptPaths = {'/api/health', '/api/pair', '/api/auth/refresh'};

/// Marks a request that has already been retried once, so a server that answers 401
/// to a freshly-minted token cannot put us in a loop.
const _retriedFlag = 'nelle_auth_retried';

/// The access token a request actually went out with, so a 401 can be told apart from
/// a 401 that a *different* request already fixed. See [_TokenRefresher].
const _sentTokenKey = 'nelle_auth_sent_token';

/// Attaches the device bearer token, and renews it when the server says it is stale.
///
/// Two things about this are not the textbook shape, and both are load-bearing:
///
/// **1. The refresh lives in `onResponse`, not `onError`.** The dio client is built
/// with `validateStatus: (_) => true` so that `NelleError` bodies can be read off
/// non-2xx responses — which means dio routes *every* response, 401 included, to
/// `onResponse`. An interceptor that waits for `onError` is dead code, and the symptom
/// is not an exception: it is a client that silently stops being authenticated, with
/// every test still green.
///
/// **2. The refresh is single-flight, and version-checked.** The server rotates both
/// tokens on every refresh and keeps exactly one pair per device, so a *second* refresh
/// invalidates the first one's results. The client streams (chat SSE, router SSE) and
/// polls concurrently, so an expired access token produces several 401s at once. If
/// each of them refreshed, the second would present an already-rotated token, be told
/// `refresh_token_invalid`, and tear down a session that was working. So: one refresh
/// in flight ([_TokenRefresher]), and a 401 for a token that has *already* been
/// replaced is simply retried with the new one rather than triggering another.
class AuthInterceptor extends Interceptor {
  AuthInterceptor({
    required this.tokenStore,
    required this.retry,
    required this.onAuthLost,
    required this.refreshTokens,
  }) : _refresher = _TokenRefresher(refreshTokens);

  final TokenStore tokenStore;

  /// Re-issues a request. Injected rather than reaching for the Dio instance, so the
  /// interceptor can be tested without one.
  final Future<Response<dynamic>> Function(RequestOptions options) retry;

  /// The refresh token was refused: this device is not paired any more (revoked, or
  /// the server's database was replaced). Presenting it again would 401 forever.
  final Future<void> Function() onAuthLost;

  /// POSTs the refresh token and returns the new pair, or `null` if the server refused.
  final Future<IssuedTokens?> Function(String refreshToken) refreshTokens;

  final _TokenRefresher _refresher;

  @override
  Future<void> onRequest(
    RequestOptions options,
    RequestInterceptorHandler handler,
  ) async {
    if (_isExempt(options.path)) {
      return handler.next(options);
    }
    final tokens = await tokenStore.read();
    if (tokens != null) {
      options.headers['authorization'] = 'Bearer ${tokens.accessToken}';
      options.extra[_sentTokenKey] = tokens.accessToken;
    }
    handler.next(options);
  }

  @override
  Future<void> onResponse(
    Response<dynamic> response,
    ResponseInterceptorHandler handler,
  ) async {
    final options = response.requestOptions;
    if (response.statusCode != 401 ||
        _isExempt(options.path) ||
        options.extra[_retriedFlag] == true) {
      return handler.next(response);
    }

    final sent = options.extra[_sentTokenKey] as String?;
    if (sent == null) {
      // No token was attached, so there is nothing to renew: this connection is not
      // paired and the server is right to refuse it.
      return handler.next(response);
    }

    final current = await tokenStore.read();
    if (current != null && current.accessToken != sent) {
      // Another request already refreshed while this one was in flight. Refreshing
      // again would rotate the pair a second time and revoke the token that just
      // fixed everything else. Just use it.
      return _replay(options, current.accessToken, response, handler);
    }

    final renewed = await _refresher.refresh(sent, tokenStore);
    if (renewed == null) {
      await onAuthLost();
      return handler.next(response);
    }
    return _replay(options, renewed.accessToken, response, handler);
  }

  Future<void> _replay(
    RequestOptions options,
    String accessToken,
    Response<dynamic> original,
    ResponseInterceptorHandler handler,
  ) async {
    options.headers['authorization'] = 'Bearer $accessToken';
    options.extra[_retriedFlag] = true;
    try {
      handler.resolve(await retry(options));
    } catch (_) {
      // The retry itself failed (the network went away). Hand back the 401 rather
      // than an exception the caller cannot read a NelleError off.
      handler.next(original);
    }
  }

  bool _isExempt(String path) => _authExemptPaths.any(path.endsWith);
}

/// Ensures exactly one refresh is in flight, whatever the concurrency.
class _TokenRefresher {
  _TokenRefresher(this._refreshTokens);

  final Future<IssuedTokens?> Function(String refreshToken) _refreshTokens;

  Future<IssuedTokens?>? _inFlight;

  Future<IssuedTokens?> refresh(String staleAccessToken, TokenStore store) {
    // Every caller awaits the same future, so N simultaneous 401s cause one refresh.
    return _inFlight ??= _refresh(store).whenComplete(() => _inFlight = null);
  }

  Future<IssuedTokens?> _refresh(TokenStore store) async {
    final tokens = await store.read();
    if (tokens == null) {
      return null;
    }
    final renewed = await _refreshTokens(tokens.refreshToken);
    if (renewed == null) {
      await store.clear();
      return null;
    }
    await store.write(renewed);
    return renewed;
  }
}
