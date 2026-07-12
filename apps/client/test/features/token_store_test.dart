import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/generated/models/issued_tokens.dart';
import 'package:nelle_agent/src/features/connection/token_store.dart';

/// A keyring that answers, and one that is not there at all.
///
/// The second is not hypothetical: `flutter_secure_storage` on Linux needs libsecret
/// *and* a running secret service, and a bare window manager has neither. The store
/// must degrade rather than throw -- loopback is unauthenticated and must keep working
/// on a machine that cannot keep a secret.
class _FakeStorage implements SecretStorage {
  _FakeStorage({this.broken = false});

  final bool broken;
  final Map<String, String> values = {};

  Never _fail() => throw PlatformException(
    code: 'Libsecret error',
    message: 'no secret service on the session bus',
  );

  @override
  Future<String?> read(String key) async => broken ? _fail() : values[key];

  @override
  Future<void> write(String key, String value) async =>
      broken ? _fail() : values[key] = value;

  @override
  Future<void> delete(String key) async =>
      broken ? _fail() : values.remove(key);
}

const _tokens = IssuedTokens(
  deviceId: 'device-1',
  accessToken: 'access-1',
  accessExpiresAt: '2026-07-12T21:17:31.577Z',
  refreshToken: 'refresh-1',
);

void main() {
  test('tokens round-trip through the keyring', () async {
    final storage = _FakeStorage();
    final store = SecureTokenStore(storage);

    expect(await store.read(), isNull);
    await store.write(_tokens);

    final read = await store.read();
    expect(read?.accessToken, 'access-1');
    expect(read?.refreshToken, 'refresh-1');
    expect(read?.accessExpiresAt, '2026-07-12T21:17:31.577Z');

    await store.clear();
    expect(await store.read(), isNull);
  });

  test(
    'a machine with no secret service reports unavailable instead of throwing',
    () async {
      final store = SecureTokenStore(_FakeStorage(broken: true));

      // The whole reason `isAvailable` exists. Throwing here would take down a desktop
      // user who never wanted to pair: loopback is unauthenticated and needs no keyring
      // at all, so a missing one must cost only remote pairing.
      expect(await store.isAvailable(), isFalse);
      expect(await store.read(), isNull);
      await expectLater(store.clear(), completes);
    },
  );

  test('an available keyring says so', () async {
    expect(await SecureTokenStore(_FakeStorage()).isAvailable(), isTrue);
  });

  test(
    'a corrupt keyring entry reads as "no tokens", not as a crash on launch',
    () async {
      final storage = _FakeStorage();
      storage.values['nelle_device_tokens'] = 'not json at all';

      // The app opens, unpaired, and the user pairs again. The alternative is an app
      // that cannot start because of a value it wrote itself.
      expect(await SecureTokenStore(storage).read(), isNull);
    },
  );

  test(
    'what is written is the wire shape, so the server can read it back',
    () async {
      final storage = _FakeStorage();
      await SecureTokenStore(storage).write(_tokens);

      final stored =
          jsonDecode(storage.values['nelle_device_tokens']!)
              as Map<String, Object?>;
      expect(stored, {
        // The device id is stored with the tokens because the server only ever says it
        // once, at pairing: `GET /api/devices` is loopback-only, so a paired device
        // that forgets its id can never ask for it again.
        'deviceId': 'device-1',
        'accessToken': 'access-1',
        'accessExpiresAt': '2026-07-12T21:17:31.577Z',
        'refreshToken': 'refresh-1',
      });
    },
  );

  test('the in-memory store satisfies the same contract', () async {
    final store = InMemoryTokenStore();
    expect(await store.isAvailable(), isTrue);
    expect(await store.read(), isNull);
    await store.write(_tokens);
    expect((await store.read())?.accessToken, 'access-1');
    await store.clear();
    expect(await store.read(), isNull);
  });
}
