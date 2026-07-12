import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config.dart';

/// Which server the app talks to, and on what terms.
///
/// Two kinds, and the difference is the whole of M5:
///
/// * **Loopback** — `http://127.0.0.1:8787`. The server constructs that listener
///   `{trusted: true}`: arriving there is itself proof of local access, so there is no
///   token and there never will be. Pairing must not become a step the desktop user has
///   to perform.
/// * **Paired** — `https://<lan-ip>:8788`. A self-signed cert pinned by [certFingerprint],
///   and a device bearer token on every request. The fingerprint is handed over
///   out-of-band at pairing time, so this is pre-shared pinning, not trust-on-first-use.
///
/// The tokens are deliberately **not** here. They are secrets and live in the
/// [TokenStore]; this object is persisted in plain SharedPreferences, and a connection
/// is a destination, not a credential.
@immutable
class ServerConnection {
  const ServerConnection({
    required this.baseUrl,
    this.certFingerprint,
    this.deviceId,
  });

  const ServerConnection.loopback()
    : baseUrl = defaultServerBaseUrl,
      certFingerprint = null,
      deviceId = null;

  final String baseUrl;

  /// SHA-256 of the server's cert DER, uppercase colon-hex — the same string
  /// `openssl x509 -fingerprint -sha256` prints, and the same one the server puts in
  /// the pairing payload. `null` on loopback: there is no TLS to pin.
  final String? certFingerprint;

  /// The id the server assigned this device when it paired. `null` until it has.
  final String? deviceId;

  /// A paired connection carries a bearer token; a loopback one must not.
  bool get isPaired => deviceId != null;

  /// True when this points at the local machine, whatever port. Used to decide
  /// whether the loopback-only routes (pair/code, devices) are worth showing: they
  /// answer 404 anywhere else, by design.
  bool get isLoopback {
    final host = Uri.tryParse(baseUrl)?.host;
    return host == '127.0.0.1' || host == 'localhost' || host == '::1';
  }

  ServerConnection copyWith({
    String? baseUrl,
    String? certFingerprint,
    String? deviceId,
  }) => ServerConnection(
    baseUrl: baseUrl ?? this.baseUrl,
    certFingerprint: certFingerprint ?? this.certFingerprint,
    deviceId: deviceId ?? this.deviceId,
  );

  @override
  bool operator ==(Object other) =>
      other is ServerConnection &&
      other.baseUrl == baseUrl &&
      other.certFingerprint == certFingerprint &&
      other.deviceId == deviceId;

  @override
  int get hashCode => Object.hash(baseUrl, certFingerprint, deviceId);

  @override
  String toString() =>
      'ServerConnection($baseUrl, paired: $isPaired, pinned: ${certFingerprint != null})';
}

const _baseUrlKey = 'server_base_url';
const _fingerprintKey = 'server_cert_fingerprint';
const _deviceIdKey = 'server_device_id';

/// The server this app is currently pointed at, persisted across launches.
///
/// Defaults to loopback, so a desktop install keeps working exactly as it did with no
/// pairing, no keyring, and no tokens.
final connectionProvider =
    NotifierProvider<ConnectionNotifier, ServerConnection>(
      ConnectionNotifier.new,
    );

class ConnectionNotifier extends Notifier<ServerConnection> {
  @override
  ServerConnection build() {
    final prefs = ref.watch(sharedPreferencesProvider);
    final stored = prefs.getString(_baseUrlKey)?.trim();
    if (stored == null || stored.isEmpty) {
      return const ServerConnection.loopback();
    }
    return ServerConnection(
      baseUrl: stored,
      certFingerprint: prefs.getString(_fingerprintKey),
      deviceId: prefs.getString(_deviceIdKey),
    );
  }

  /// Points at a server with no pairing — the loopback case, and the manual URL box.
  /// Clears any pin and device id: they belonged to the *other* server.
  Future<void> setBaseUrl(String url) async {
    final normalized = url.trim().isEmpty ? defaultServerBaseUrl : url.trim();
    await _persist(ServerConnection(baseUrl: normalized));
  }

  /// Adopts a server this device has just paired with.
  Future<void> setPaired({
    required String baseUrl,
    required String certFingerprint,
    required String deviceId,
  }) async {
    await _persist(
      ServerConnection(
        baseUrl: baseUrl,
        certFingerprint: certFingerprint,
        deviceId: deviceId,
      ),
    );
  }

  /// Forgets the pairing and falls back to loopback. Called when the refresh token is
  /// rejected (the server revoked this device) — the app is not paired any more, and
  /// pretending otherwise would 401 every request forever.
  Future<void> unpair() async {
    await _persist(const ServerConnection.loopback());
  }

  Future<void> _persist(ServerConnection connection) async {
    final prefs = ref.read(sharedPreferencesProvider);
    await prefs.setString(_baseUrlKey, connection.baseUrl);
    if (connection.certFingerprint == null) {
      await prefs.remove(_fingerprintKey);
    } else {
      await prefs.setString(_fingerprintKey, connection.certFingerprint!);
    }
    if (connection.deviceId == null) {
      await prefs.remove(_deviceIdKey);
    } else {
      await prefs.setString(_deviceIdKey, connection.deviceId!);
    }
    state = connection;
  }
}
