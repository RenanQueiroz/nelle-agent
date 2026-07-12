import 'dart:typed_data';

import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/generated/models/pairing_payload.dart';
import 'package:nelle_agent/src/features/connection/join_server.dart';

const _payload = {
  'lanUrls': ['https://172.31.126.21:8788', 'https://192.168.4.75:8788'],
  'tlsPort': 8788,
  'certFingerprint': '6F:20:CC:5E',
  'code': 'JU32ZKU6',
  'expiresAt': '2026-07-12T21:00:00.000Z',
};

void main() {
  group('reading the pairing details', () {
    test('the whole payload is taken in one paste', () {
      final parsed = parsePairingPayload(jsonEncode(_payload));

      // One paste carries all three things a device needs: where to go, the one-time
      // code, and -- crucially -- the fingerprint to pin. Nobody retypes 32 bytes of
      // hex, and a connection without it is worthless.
      expect(parsed, isA<PairingPayload>());
      expect(parsed!.lanUrls, hasLength(2));
      expect(parsed.certFingerprint, '6F:20:CC:5E');
      expect(parsed.code, 'JU32ZKU6');
    });

    test('leading and trailing whitespace from a clipboard is tolerated', () {
      expect(parsePairingPayload('  \n${jsonEncode(_payload)}\n '), isNotNull);
    });

    test('a payload with no certificate to pin is refused', () {
      // It would connect to *something*, unpinned -- which is the one thing this design
      // exists to prevent. Better to say so before pairing than to fail at the
      // handshake, or worse, to succeed against the wrong server.
      final noPin = Map<String, Object?>.from(_payload)
        ..['certFingerprint'] = null;
      expect(parsePairingPayload(jsonEncode(noPin)), isNull);
    });

    test('a payload with no address is refused', () {
      final noUrls = Map<String, Object?>.from(_payload)
        ..['lanUrls'] = <String>[];
      expect(parsePairingPayload(jsonEncode(noUrls)), isNull);
    });

    test('nonsense is refused rather than half-parsed', () {
      expect(parsePairingPayload(''), isNull);
      expect(parsePairingPayload('   '), isNull);
      expect(parsePairingPayload('JU32ZKU6'), isNull);
      expect(parsePairingPayload('{"nope": true}'), isNull);
      expect(parsePairingPayload('not json'), isNull);
      // A JSON array is valid JSON and not a payload.
      expect(parsePairingPayload('[1,2,3]'), isNull);
    });
  });

  group('pairing with a server that answers something unexpected', () {
    test(
      'a 200 with an unreadable body is a sentence, not a type-cast error',
      () async {
        // Found by driving: the server was one commit behind and did not send `deviceId`
        // yet, so `IssuedTokens.fromJson` cast a null and the *user* was shown
        //   type 'Null' is not a subtype of type 'String' in type cast
        // A 200 whose body we cannot read means the other end is not the Nelle this app
        // was built against, and that is what it should say.
        final repository = JoinServerRepository();
        final dio = Dio(BaseOptions(validateStatus: (_) => true))
          ..httpClientAdapter = _StubAdapter(
            ResponseBody.fromString(
              // Valid JSON, valid 200 -- and missing a required field.
              '{"accessToken":"a","accessExpiresAt":"t","refreshToken":"r"}',
              200,
              headers: {
                Headers.contentTypeHeader: [Headers.jsonContentType],
              },
            ),
          );

        await expectLater(
          repository.pairWith(dio, code: 'JU32ZKU6', deviceName: 'test'),
          throwsA(
            isA<JoinFailure>().having(
              (f) => f.message,
              'message',
              contains('different version'),
            ),
          ),
        );
      },
    );
  });
}

class _StubAdapter implements HttpClientAdapter {
  _StubAdapter(this.response);

  final ResponseBody response;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => response;

  @override
  void close({bool force = false}) {}
}
