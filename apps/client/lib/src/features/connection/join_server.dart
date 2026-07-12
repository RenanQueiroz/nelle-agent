import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/issued_tokens.dart';
import '../../api/generated/models/pairing_payload.dart';
import 'pinned_adapter.dart';
import 'secure_storage.dart';
import 'token_store.dart';
import 'server_connection.dart';

/// Joining a server: take the details it printed, find it, trust it, and pair.
///
/// The details arrive out-of-band — scanned from the QR, or pasted/typed from the host
/// screen. That is not incidental, it is the security model: the certificate
/// fingerprint travels through a channel the network cannot touch, so the pin is
/// *pre-shared* rather than learned from the very party we are trying to authenticate.

/// Reads the pairing details out of whatever the user gave us.
///
/// The whole JSON blob (copied from the host, or scanned) is the happy path, because it
/// carries the fingerprint — which nobody is going to retype 32 bytes of by hand, and
/// which the connection is worthless without.
PairingPayload? parsePairingPayload(String raw) {
  final text = raw.trim();
  if (text.isEmpty) {
    return null;
  }
  try {
    final decoded = jsonDecode(text);
    if (decoded is! Map<String, Object?>) {
      return null;
    }
    final payload = PairingPayload.fromJson(decoded);
    // A payload with no address, or no certificate to pin, cannot be connected to.
    // Better to say so now than to fail at the handshake.
    if (payload.lanUrls.isEmpty || payload.certFingerprint == null) {
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

class JoinResult {
  const JoinResult({required this.baseUrl, required this.tokens});

  final String baseUrl;
  final IssuedTokens tokens;
}

class JoinFailure implements Exception {
  const JoinFailure(this.message);

  final String message;

  @override
  String toString() => message;
}

class JoinServerRepository {
  const JoinServerRepository();

  /// Finds the first offered address that actually answers, over pinned TLS.
  ///
  /// The server offers every one of its addresses because it cannot know which the
  /// device can see — a machine has a LAN address, maybe a VPN, maybe docker, and on
  /// WSL2 a NAT address no phone can reach. Only the client can find out, and it finds
  /// out by asking.
  ///
  /// The probe is pinned like everything else: an address that answers but presents the
  /// wrong certificate is not the server we were told about.
  Future<String> findReachable(PairingPayload payload) async {
    for (final url in payload.lanUrls) {
      final dio = Dio(
        BaseOptions(
          baseUrl: url,
          validateStatus: (_) => true,
          connectTimeout: const Duration(seconds: 3),
          receiveTimeout: const Duration(seconds: 3),
        ),
      )..httpClientAdapter = pinnedAdapter(payload.certFingerprint)!;
      try {
        final response = await dio.get<Object?>('/api/health');
        if (response.statusCode == 200) {
          return url;
        }
      } on DioException {
        // Not reachable from here, or not the server we were told about. Try the next.
      } finally {
        dio.close();
      }
    }
    throw JoinFailure(
      payload.lanUrls.length == 1
          ? 'Could not reach ${payload.lanUrls.single}. Is the device on the same network?'
          : 'None of the server\'s ${payload.lanUrls.length} addresses answered. '
                'Is the device on the same network?',
    );
  }

  /// Exchanges the one-time code for this device's tokens.
  Future<IssuedTokens> pair({
    required String baseUrl,
    required String certFingerprint,
    required String code,
    required String deviceName,
  }) {
    final dio = Dio(BaseOptions(baseUrl: baseUrl, validateStatus: (_) => true))
      ..httpClientAdapter = pinnedAdapter(certFingerprint)!;
    return pairWith(dio, code: code, deviceName: deviceName);
  }

  /// The exchange itself, against a caller-supplied client -- so the response handling
  /// can be tested without standing up a TLS server with a matching certificate.
  Future<IssuedTokens> pairWith(
    Dio dio, {
    required String code,
    required String deviceName,
  }) async {
    try {
      final response = await dio.post<Map<String, Object?>>(
        '/api/pair',
        data: {'code': code, 'deviceName': deviceName, 'platform': _platform()},
      );
      final status = response.statusCode ?? 0;
      if (status < 200 || status >= 300 || response.data == null) {
        // The server's own sentence: it knows whether the code was wrong or expired,
        // and ours would only be a guess at which.
        throw JoinFailure(
          _errorMessage(response.data) ?? 'Pairing failed ($status).',
        );
      }
      try {
        return IssuedTokens.fromJson(response.data!);
      } catch (_) {
        // A 200 whose body is not the shape we expect means the other end is not the
        // Nelle this app was built against. Saying so is useful; showing the user
        // "type 'Null' is not a subtype of type 'String' in type cast" is not -- and
        // that is exactly what leaked out when a server predating `deviceId` answered.
        throw const JoinFailure(
          'The server accepted the code but answered with something this app does not '
          'understand. It is probably running a different version of Nelle.',
        );
      }
    } on DioException catch (error) {
      throw JoinFailure(
        'Could not reach the server: ${error.message ?? error.type.name}',
      );
    } finally {
      dio.close();
    }
  }
}

final joinServerRepositoryProvider = Provider<JoinServerRepository>(
  (ref) => const JoinServerRepository(),
);

/// Drives the whole join: probe, pair, store the tokens, and point the app at the
/// server it just joined.
final joinServerProvider = Provider<JoinServer>(
  (ref) => JoinServer(
    repository: ref.watch(joinServerRepositoryProvider),
    tokenStore: ref.watch(tokenStoreProvider),
    connection: ref.watch(connectionProvider.notifier),
  ),
);

class JoinServer {
  const JoinServer({
    required this.repository,
    required this.tokenStore,
    required this.connection,
  });

  final JoinServerRepository repository;
  final TokenStore tokenStore;
  final ConnectionNotifier connection;

  Future<void> call(PairingPayload payload, {String? deviceName}) async {
    // Refuse before pairing, not after: a token we cannot keep is a session that dies
    // silently at the next restart, and the user would have no idea why.
    if (!await tokenStore.isAvailable()) {
      throw const JoinFailure(
        'This machine has no keyring to store the token in. On Linux, remote pairing '
        'needs a secret service (gnome-keyring, KWallet or KeePassXC) running.',
      );
    }

    final baseUrl = await repository.findReachable(payload);
    final tokens = await repository.pair(
      baseUrl: baseUrl,
      certFingerprint: payload.certFingerprint!,
      code: payload.code,
      deviceName: deviceName?.trim().isNotEmpty == true
          ? deviceName!.trim()
          : _defaultDeviceName(),
    );

    // Tokens first: if the app switched connection and *then* failed to store them,
    // every subsequent request would 401 against a server it thinks it is paired with.
    await tokenStore.write(tokens);
    await connection.setPaired(
      baseUrl: baseUrl,
      certFingerprint: payload.certFingerprint!,
      deviceId: tokens.deviceId,
    );
  }
}

/// No `dart:io` here: importing it would break the web build, which is the very thing
/// the conditionally-imported pinned adapter exists to preserve. `defaultTargetPlatform`
/// answers everywhere.
String _defaultDeviceName() => switch (defaultTargetPlatform) {
  TargetPlatform.android => 'Android device',
  TargetPlatform.iOS => 'iPhone',
  TargetPlatform.linux => 'Linux desktop',
  TargetPlatform.macOS => 'Mac',
  TargetPlatform.windows => 'Windows PC',
  TargetPlatform.fuchsia => 'Fuchsia device',
};

String _platform() => kIsWeb ? 'web' : defaultTargetPlatform.name;

String? _errorMessage(Map<String, Object?>? body) {
  final error = body?['error'];
  return error is Map && error['message'] is String
      ? error['message'] as String
      : null;
}
