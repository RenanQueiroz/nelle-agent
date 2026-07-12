import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/generated/models/issued_tokens.dart';
import 'package:nelle_agent/src/features/connection/auth_interceptor.dart';
import 'package:nelle_agent/src/features/connection/cert_pinning.dart';
import 'package:nelle_agent/src/features/connection/token_store.dart';

IssuedTokens _tokens(String suffix) => IssuedTokens(
  deviceId: 'device-1',
  accessToken: 'access-$suffix',
  accessExpiresAt: '2026-07-12T21:17:31.577Z',
  refreshToken: 'refresh-$suffix',
);

/// Drives the interceptor the way dio does, so the test exercises the real handler
/// contract (`next` vs `resolve`) rather than a paraphrase of it.
class _Harness {
  _Harness({
    required this.store,
    this.refreshAnswers = const [],
    this.retryStatus = 200,
  });

  final TokenStore store;

  /// What the server says to each successive refresh. `null` = refused.
  final List<IssuedTokens?> refreshAnswers;
  final int retryStatus;

  int refreshCalls = 0;
  int retries = 0;
  int authLost = 0;
  final List<String?> retriedWithToken = [];

  late final AuthInterceptor interceptor = AuthInterceptor(
    tokenStore: store,
    onAuthLost: () async => authLost += 1,
    refreshTokens: (_) async {
      final answer = refreshCalls < refreshAnswers.length
          ? refreshAnswers[refreshCalls]
          : null;
      refreshCalls += 1;
      // A real refresh is a network round trip: yield, so a second 401 arriving in
      // the meantime has a chance to start its own (which is the bug under test).
      await Future<void>.delayed(const Duration(milliseconds: 10));
      return answer;
    },
    retry: (options) async {
      retries += 1;
      retriedWithToken.add(options.headers['authorization'] as String?);
      return Response<dynamic>(
        requestOptions: options,
        statusCode: retryStatus,
        data: {'ok': true},
      );
    },
  );

  /// One request/response cycle: attach the token, then hand back [status].
  Future<Response<dynamic>> call({
    String path = '/api/conversations',
    int status = 401,
  }) async {
    final options = RequestOptions(path: path);
    await interceptor.onRequest(options, RequestInterceptorHandler());

    final response = Response<dynamic>(
      requestOptions: options,
      statusCode: status,
      data: {
        'error': {'code': 'unauthorized'},
      },
    );
    final handler = _CapturingHandler();
    await interceptor.onResponse(response, handler);
    return handler.result;
  }
}

/// Captures whichever of `next`/`resolve` the interceptor calls.
class _CapturingHandler extends ResponseInterceptorHandler {
  late Response<dynamic> result;

  @override
  void next(Response<dynamic> response) => result = response;

  @override
  void resolve(
    Response<dynamic> response, [
    bool callFollowingResponseInterceptor = false,
  ]) => result = response;
}

void main() {
  test(
    'a 401 is refreshed and the request replayed with the new token',
    () async {
      final store = InMemoryTokenStore()..write(_tokens('old'));
      final harness = _Harness(store: store, refreshAnswers: [_tokens('new')]);

      final response = await harness.call();

      expect(harness.refreshCalls, 1);
      expect(harness.retries, 1);
      expect(harness.retriedWithToken.single, 'Bearer access-new');
      expect(
        response.statusCode,
        200,
        reason: 'the caller sees the retried response, not the 401',
      );
      expect((await store.read())?.accessToken, 'access-new');
    },
  );

  test('two concurrent 401s cause exactly ONE refresh', () async {
    // The bug this exists to prevent. The server rotates both tokens on every refresh
    // and keeps one pair per device, so a second refresh invalidates the first one's
    // results. The client always has several requests in flight (chat SSE, router SSE,
    // a snapshot reload), so an expired access token 401s all of them at once -- and a
    // per-401 refresh would tear down the session it was trying to save.
    final store = InMemoryTokenStore()..write(_tokens('old'));
    final harness = _Harness(
      store: store,
      refreshAnswers: [_tokens('new'), null],
    );

    final responses = await Future.wait([
      harness.call(),
      harness.call(),
      harness.call(),
    ]);

    expect(
      harness.refreshCalls,
      1,
      reason: 'three simultaneous 401s, one refresh',
    );
    expect(harness.retries, 3, reason: 'but every request is still replayed');
    expect(responses.every((r) => r.statusCode == 200), isTrue);
    expect(
      harness.retriedWithToken.toSet(),
      {'Bearer access-new'},
      reason: 'all three replay with the token the single refresh produced',
    );
  });

  test(
    'a 401 for a token another request already replaced does not refresh again',
    () async {
      // The sequential version of the same hazard: request B was sent with the old token
      // and its 401 arrives *after* A's refresh has already landed. Refreshing again
      // would rotate the pair a second time and revoke the token that just fixed A.
      final store = InMemoryTokenStore()..write(_tokens('old'));
      final harness = _Harness(store: store, refreshAnswers: [_tokens('new')]);

      await harness.call();
      expect(harness.refreshCalls, 1);

      // B: sent with 'old', 401s late. The store already holds 'new'.
      final options = RequestOptions(path: '/api/conversations')
        ..headers['authorization'] = 'Bearer access-old'
        ..extra['nelle_auth_sent_token'] = 'access-old';
      final handler = _CapturingHandler();
      await harness.interceptor.onResponse(
        Response<dynamic>(requestOptions: options, statusCode: 401),
        handler,
      );

      expect(
        harness.refreshCalls,
        1,
        reason: 'no second refresh: the token was already renewed',
      );
      expect(harness.retriedWithToken.last, 'Bearer access-new');
      expect(handler.result.statusCode, 200);
    },
  );

  test('a refused refresh unpairs instead of retrying forever', () async {
    final store = InMemoryTokenStore()..write(_tokens('old'));
    final harness = _Harness(store: store, refreshAnswers: [null]);

    final response = await harness.call();

    expect(harness.refreshCalls, 1);
    expect(harness.retries, 0);
    expect(
      harness.authLost,
      1,
      reason: 'the device is revoked; presenting it again would 401 forever',
    );
    expect(response.statusCode, 401, reason: 'the caller sees the refusal');
    expect(await store.read(), isNull, reason: 'the dead tokens are dropped');
  });

  test('a 401 to the retried request is not retried again (no loop)', () async {
    final store = InMemoryTokenStore()..write(_tokens('old'));
    final harness = _Harness(
      store: store,
      refreshAnswers: [_tokens('new')],
      retryStatus: 401, // the server refuses even the fresh token
    );

    final response = await harness.call();

    expect(harness.refreshCalls, 1);
    expect(
      harness.retries,
      1,
      reason: 'exactly once -- a retry that 401s must not refresh again',
    );
    expect(response.statusCode, 401);
  });

  test(
    'the token routes are exempt: a 401 from /api/auth/refresh is an answer, not a prompt',
    () async {
      final store = InMemoryTokenStore()..write(_tokens('old'));
      final harness = _Harness(store: store, refreshAnswers: [_tokens('new')]);

      final response = await harness.call(path: '/api/auth/refresh');

      // Refreshing in response to a failed refresh is an infinite regress.
      expect(harness.refreshCalls, 0);
      expect(harness.retries, 0);
      expect(response.statusCode, 401);
    },
  );

  test('no tokens means no Authorization header', () async {
    final harness = _Harness(store: InMemoryTokenStore());

    final options = RequestOptions(path: '/api/conversations');
    await harness.interceptor.onRequest(options, RequestInterceptorHandler());

    expect(options.headers.containsKey('authorization'), isFalse);
  });

  group('certificate pinning', () {
    // The exact certificate this repo's server presents (T0 read it with openssl).
    const serverPin =
        '6F:20:CC:5E:27:10:27:11:69:C6:21:34:4F:4F:BA:6B:37:C2:D3:2A:55:FA:8D:1A:B0:D6:6F:68:AD:42:7B:21';

    test('the fingerprint format matches openssl byte for byte', () {
      // sha256 of no bytes -- a fixed, independently checkable value:
      //   printf '' | openssl dgst -sha256
      // The server emits uppercase colon-hex and so must we. If this format ever
      // drifts, every pin silently stops matching and every paired device falls off.
      expect(
        fingerprintOf(Uint8List(0)),
        'E3:B0:C4:42:98:FC:1C:14:9A:FB:F4:C8:99:6F:B9:24:'
        '27:AE:41:E4:64:9B:93:4C:A4:95:99:1B:78:52:B8:55',
      );
    });

    test('a certificate that is not the pinned one is refused', () {
      expect(
        certificateMatchesPin(Uint8List.fromList([1, 2, 3]), serverPin),
        isFalse,
      );
    });

    test('a matching certificate is accepted, however the pin was typed', () {
      final der = Uint8List.fromList([1, 2, 3]);
      final pin = fingerprintOf(der);

      expect(certificateMatchesPin(der, pin), isTrue);
      // A user retyping a fingerprint drops the colons and the case. The bytes are
      // what matter.
      expect(certificateMatchesPin(der, pin.toLowerCase()), isTrue);
      expect(certificateMatchesPin(der, pin.replaceAll(':', '')), isTrue);
    });

    test('no pin means nothing is trusted', () {
      // `badCertificateCallback` only fires for a certificate the platform already
      // refused. Answering "true" there with no pin to check against is how a client
      // ends up trusting anything an attacker presents.
      expect(
        certificateMatchesPin(Uint8List.fromList([1, 2, 3]), null),
        isFalse,
      );
      expect(certificateMatchesPin(Uint8List.fromList([1, 2, 3]), ''), isFalse);
    });
  });
}
