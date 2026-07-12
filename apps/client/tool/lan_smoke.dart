// Drives the real pairing + pinning + bearer + refresh path against a *live* Nelle
// server, using the client's own transport code (dioProvider, AuthInterceptor,
// pinnedAdapter). Dev-only; nothing in the app calls it.
//
// It exists because the interesting half of M5 cannot be unit-tested honestly. A fake
// TLS handshake proves nothing about whether `badCertificateCallback` fires, whether
// the fingerprint we compute matches the one the server actually presents, or whether
// a rotated token really does invalidate its predecessor. Those are properties of the
// server and of dart:io, not of our code, and the only way to know them is to ask.
//
//   1. Start Nelle with LAN access on (Settings > Remote access, then restart).
//   2. cd apps/client && dart run tool/lan_smoke.dart
//
// Optional: pass the loopback URL as the first argument (default http://127.0.0.1:8787).
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:nelle_agent/src/features/connection/auth_interceptor.dart';
import 'package:nelle_agent/src/api/generated/models/issued_tokens.dart';
import 'package:nelle_agent/src/features/connection/pinned_adapter.dart';
import 'package:nelle_agent/src/features/connection/token_store.dart';

int _failures = 0;

void check(String what, bool ok, [String detail = '']) {
  stdout.writeln(
    '${ok ? '  ok  ' : '  FAIL'} $what${detail.isEmpty ? '' : '  ($detail)'}',
  );
  if (!ok) _failures += 1;
}

Future<void> main(List<String> args) async {
  final loopback = args.isNotEmpty ? args.first : 'http://127.0.0.1:8787';
  final admin = Dio(
    BaseOptions(baseUrl: loopback, validateStatus: (_) => true),
  );

  stdout.writeln(
    '\n== minting a pairing code on the trusted loopback listener',
  );
  final minted = await admin.post<Map<String, Object?>>('/api/pair/code');
  if (minted.statusCode != 200) {
    stderr.writeln(
      'could not mint a code (${minted.statusCode}). Is the server running?',
    );
    exit(1);
  }
  final payload = minted.data!['qrPayload']! as Map<String, Object?>;
  final lanUrls = (payload['lanUrls']! as List).cast<String>();
  final pin = payload['certFingerprint'] as String?;
  final code = payload['code']! as String;

  if (lanUrls.isEmpty || pin == null) {
    stderr.writeln(
      'LAN access is off: the payload offers no URL and no certificate.',
    );
    stderr.writeln('Turn on Settings > Remote access and restart the server.');
    exit(1);
  }
  stdout.writeln('   offers ${lanUrls.length} URL(s): ${lanUrls.join(', ')}');
  stdout.writeln('   pin ${pin.substring(0, 17)}...');

  // Probe, exactly as a client must: the server cannot know which of its addresses we
  // can see, so it offers all of them and we find one that answers.
  String? reachable;
  for (final url in lanUrls) {
    final probe = Dio(BaseOptions(baseUrl: url, validateStatus: (_) => true))
      ..httpClientAdapter = pinnedAdapter(pin)!;
    try {
      final health = await probe.get<Object?>('/api/health');
      if (health.statusCode == 200) {
        reachable = url;
        break;
      }
    } on DioException {
      // Not this one.
    }
  }
  check(
    'a LAN URL answers over pinned TLS',
    reachable != null,
    reachable ?? 'none reachable',
  );
  if (reachable == null) exit(1);

  stdout.writeln('\n== the pin is the whole trust decision');
  final wrongPin =
      Dio(BaseOptions(baseUrl: reachable, validateStatus: (_) => true))
        ..httpClientAdapter = pinnedAdapter(
          '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:'
          '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
        )!;
  var refused = false;
  try {
    await wrongPin.get<Object?>('/api/health');
  } on DioException {
    refused = true;
  }
  check('a certificate that is not the pinned one is REFUSED', refused);

  stdout.writeln('\n== pairing');
  final store = InMemoryTokenStore();
  final dio = Dio(BaseOptions(baseUrl: reachable, validateStatus: (_) => true))
    ..httpClientAdapter = pinnedAdapter(pin)!;

  final unauth = await dio.get<Object?>('/api/conversations');
  check(
    'an unpaired device is refused',
    unauth.statusCode == 401,
    '${unauth.statusCode}',
  );

  final paired = await dio.post<Map<String, Object?>>(
    '/api/pair',
    data: {'code': code, 'deviceName': 'lan_smoke', 'platform': 'linux'},
  );
  check('pairing with the minted code succeeds', paired.statusCode == 200);
  await store.write(IssuedTokens.fromJson(paired.data!));

  final replay = await dio.post<Map<String, Object?>>(
    '/api/pair',
    data: {'code': code, 'deviceName': 'replay', 'platform': 'linux'},
  );
  check(
    'the code is single-use',
    replay.statusCode == 400,
    '${replay.data?['error']?.toString().substring(0, 40) ?? ''}...',
  );

  stdout.writeln('\n== the interceptor: bearer, refresh, replay');
  var authLost = 0;
  dio.interceptors.add(
    AuthInterceptor(
      tokenStore: store,
      retry: dio.fetch,
      onAuthLost: () async => authLost += 1,
      refreshTokens: (refreshToken) async {
        final r = await dio.post<Map<String, Object?>>(
          '/api/auth/refresh',
          data: {'refreshToken': refreshToken},
        );
        return r.statusCode == 200 ? IssuedTokens.fromJson(r.data!) : null;
      },
    ),
  );

  final authed = await dio.get<Object?>('/api/conversations');
  check(
    'a paired device is served',
    authed.statusCode == 200,
    '${authed.statusCode}',
  );

  // Forge an expiry: put a dead access token in the store, keeping the live refresh
  // token. The next request 401s, the interceptor refreshes, and the caller never
  // sees the 401 at all.
  final live = (await store.read())!;
  await store.write(
    IssuedTokens(
      accessToken: 'expired-nonsense',
      accessExpiresAt: live.accessExpiresAt,
      refreshToken: live.refreshToken,
    ),
  );

  final renewed = await dio.get<Object?>('/api/conversations');
  check(
    'a stale access token is renewed transparently',
    renewed.statusCode == 200,
    '${renewed.statusCode}',
  );
  check(
    'the store now holds a different access token',
    (await store.read())!.accessToken != 'expired-nonsense',
  );

  // The concurrency case, against the real server: several requests, one dead token.
  // A per-401 refresh would rotate twice and revoke its own session.
  final live2 = (await store.read())!;
  await store.write(
    IssuedTokens(
      accessToken: 'expired-again',
      accessExpiresAt: live2.accessExpiresAt,
      refreshToken: live2.refreshToken,
    ),
  );
  final concurrent = await Future.wait([
    dio.get<Object?>('/api/conversations'),
    dio.get<Object?>('/api/settings/network'),
    dio.get<Object?>('/api/commands'),
  ]);
  check(
    'three concurrent stale requests all succeed',
    concurrent.every((r) => r.statusCode == 200),
    concurrent.map((r) => r.statusCode).join(','),
  );

  stdout.writeln('\n== revocation');
  final devices = await admin.get<Map<String, Object?>>('/api/devices');
  final mine = (devices.data!['devices']! as List)
      .cast<Map<String, Object?>>()
      .where((d) => d['name'] == 'lan_smoke')
      .toList();
  for (final device in mine) {
    await admin.delete<Object?>('/api/devices/${device['id']}');
  }
  check('the device was revoked from loopback', mine.isNotEmpty);

  // Everything it holds is now dead: the access token 401s, and the refresh token it
  // would renew with is gone too. That is not a retry -- it is an unpairing.
  final afterRevoke = await dio.get<Object?>('/api/conversations');
  check(
    'a revoked device is refused',
    afterRevoke.statusCode == 401,
    '${afterRevoke.statusCode}',
  );
  check(
    '...and the client unpairs rather than retrying forever',
    authLost == 1,
    'authLost=$authLost',
  );
  check('...and drops the dead tokens', await store.read() == null);

  stdout.writeln(
    _failures == 0 ? '\nall checks passed\n' : '\n$_failures CHECK(S) FAILED\n',
  );
  exit(_failures == 0 ? 0 : 1);
}
