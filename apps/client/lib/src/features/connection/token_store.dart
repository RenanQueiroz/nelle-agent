import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../api/generated/models/issued_tokens.dart';

/// Where a paired device's tokens live.
///
/// Tokens are secrets: they go to the platform keystore, never to SharedPreferences.
/// The interface exists for one reason beyond testing — **[isAvailable] can be false**.
/// Secure storage is a hard dependency on a platform service, and on Linux that service
/// may simply not exist (`flutter_secure_storage` needs libsecret *plus* something
/// answering `org.freedesktop.secrets`: gnome-keyring, KWallet, KeePassXC — a bare
/// window manager has none).
///
/// So the store reports "I cannot keep a secret on this machine" rather than throwing.
/// Loopback keeps working with no keyring at all — it is unauthenticated, which is the
/// entire point — and only *remote pairing* is refused, with a sentence saying why.
/// Anything else turns a missing desktop service into a dead app for the user who never
/// wanted to pair. Android, iOS, macOS and Windows are unaffected.
abstract class TokenStore {
  /// The tokens for the paired device, or `null` if there are none.
  Future<IssuedTokens?> read();

  Future<void> write(IssuedTokens tokens);

  Future<void> clear();

  /// Whether this machine can keep a secret at all. Probed, not assumed: the only
  /// honest way to know is to ask the platform.
  Future<bool> isAvailable();
}

/// The three operations we need from a platform keystore.
///
/// Deliberately narrower than `FlutterSecureStorage`: its method signatures carry
/// per-platform option types that change between major versions (10.x renamed
/// `IOSOptions` to `AppleOptions`), and a test double that mirrors the whole surface
/// breaks on a dependency bump without a single line of our code being wrong.
abstract class SecretStorage {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class FlutterSecretStorage implements SecretStorage {
  const FlutterSecretStorage([this.storage = const FlutterSecureStorage()]);

  final FlutterSecureStorage storage;

  @override
  Future<String?> read(String key) => storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => storage.delete(key: key);
}

class SecureTokenStore implements TokenStore {
  SecureTokenStore([SecretStorage? storage])
    : _storage = storage ?? const FlutterSecretStorage();

  static const _key = 'nelle_device_tokens';

  final SecretStorage _storage;

  @override
  Future<IssuedTokens?> read() async {
    try {
      final raw = await _storage.read(_key);
      if (raw == null) {
        return null;
      }
      return IssuedTokens.fromJson(jsonDecode(raw) as Map<String, Object?>);
    } catch (error) {
      // A keyring that is missing, locked, or holding something we cannot parse is a
      // device that is not usefully paired. Say "no tokens" rather than crash the app
      // on launch; the caller re-pairs.
      debugPrint('secure storage read failed: $error');
      return null;
    }
  }

  @override
  Future<void> write(IssuedTokens tokens) =>
      _storage.write(_key, jsonEncode(tokens.toJson()));

  @override
  Future<void> clear() async {
    try {
      await _storage.delete(_key);
    } catch (error) {
      debugPrint('secure storage delete failed: $error');
    }
  }

  @override
  Future<bool> isAvailable() async {
    try {
      // A read is enough: it opens the collection, which is exactly the step that
      // fails when no secret service is running.
      await _storage.read(_key);
      return true;
    } catch (error) {
      debugPrint('secure storage unavailable: $error');
      return false;
    }
  }
}

/// For tests, and for a platform with no keyring where the user has chosen to proceed
/// for this session only. Nothing survives a restart, which is the honest behaviour.
class InMemoryTokenStore implements TokenStore {
  IssuedTokens? _tokens;

  @override
  Future<IssuedTokens?> read() async => _tokens;

  @override
  Future<void> write(IssuedTokens tokens) async => _tokens = tokens;

  @override
  Future<void> clear() async => _tokens = null;

  @override
  Future<bool> isAvailable() async => true;
}

final tokenStoreProvider = Provider<TokenStore>((ref) => SecureTokenStore());

/// Whether this machine can store a token at all. `false` means remote pairing is
/// unavailable here — not that the app is broken.
final tokenStorageAvailableProvider = FutureProvider<bool>(
  (ref) => ref.watch(tokenStoreProvider).isAvailable(),
);
