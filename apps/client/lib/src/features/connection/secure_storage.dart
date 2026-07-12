import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'token_store.dart';

/// The platform keystore, behind the narrow [SecretStorage] seam.
///
/// This file is the *only* one that imports `flutter_secure_storage`, which keeps the
/// token contract (and the auth interceptor, and the LAN smoke tool) free of Flutter
/// and of the plugin's FFI — they are plain Dart and can be run and tested as such.
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

final tokenStoreProvider = Provider<TokenStore>(
  (ref) => SecureTokenStore(const FlutterSecretStorage()),
);

/// Whether this machine can store a token at all. `false` means remote pairing is
/// unavailable here — not that the app is broken. See [TokenStore].
final tokenStorageAvailableProvider = FutureProvider<bool>(
  (ref) => ref.watch(tokenStoreProvider).isAvailable(),
);
