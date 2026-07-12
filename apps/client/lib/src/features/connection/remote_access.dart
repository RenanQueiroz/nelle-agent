import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/settings_schema.dart';
import '../../api/generated/models/device_view.dart';
import '../../api/generated/models/pairing_code_response.dart';
import '../../api/generated/models/pairing_payload.dart';

/// The "Remote access" half of settings, which only a *loopback* client can drive:
/// minting a pairing code and managing devices are loopback-only on the server (they
/// answer 404 to a paired device), because enrolling a device is an act of consent and
/// consent is given at the machine.

/// The `allowLanAccess` field, read off the served schema.
///
/// M5 hand-rolled a `NetworkSettingField` class for this, because the settings schema
/// was not itself served and there was no type to codegen. It is served now, and this
/// reads the real one: the label and the help -- including "Takes effect after a server
/// restart", the single most important sentence on that screen -- are the server's to
/// write, and a copy in the client is a copy that goes stale.
final networkSettingSchemaProvider = FutureProvider<SettingsField?>((
  ref,
) async {
  final schema = await ref.watch(settingsSchemaProvider.future);
  final section = schema?.sections
      .where((s) => s.slug == 'network')
      .firstOrNull;
  return section?.fields.where((f) => f.key == 'allowLanAccess').firstOrNull;
});

/// The whole served schema: every section the server offers, with its fields.
final settingsSchemaProvider = FutureProvider<SettingsSchema?>((ref) async {
  final response = await ref
      .watch(dioProvider)
      .get<Map<String, Object?>>('/api/settings/schema');
  // A non-2xx does not throw, so the status must be checked before the body is
  // believed: an error body parsed as a schema yields a settings screen with no
  // sections, which reads as "this server has no settings".
  if (!_ok(response.statusCode) || response.data == null) {
    return null;
  }
  return SettingsSchema.fromJson(response.data!);
});

/// Whether the server is currently binding a LAN listener. Note this is the *setting*,
/// not the listener: the server reads it once at boot, so turning it on does nothing
/// until a restart. The screen says so, in the server's own words.
final lanAccessProvider = AsyncNotifierProvider<LanAccessNotifier, bool>(
  LanAccessNotifier.new,
);

class LanAccessNotifier extends AsyncNotifier<bool> {
  @override
  Future<bool> build() async {
    final response = await ref
        .watch(dioProvider)
        .get<Map<String, Object?>>('/api/settings/network');
    if (!_ok(response.statusCode)) {
      return false;
    }
    return response.data?['allowLanAccess'] == true;
  }

  Future<void> set(bool enabled) async {
    state = const AsyncValue.loading();
    final response = await ref
        .read(dioProvider)
        .patch<Map<String, Object?>>(
          '/api/settings/network',
          data: {'allowLanAccess': enabled},
        );
    if (!_ok(response.statusCode)) {
      // The server refused, and it said why. Show its sentence, not ours.
      state = AsyncValue.error(
        _errorMessage(response.data) ?? 'Could not change LAN access.',
        StackTrace.current,
      );
      return;
    }
    state = AsyncValue.data(response.data?['allowLanAccess'] == true);
  }
}

/// The devices paired with this server.
final pairedDevicesProvider = FutureProvider<List<DeviceView>>((ref) async {
  final response = await ref
      .watch(dioProvider)
      .get<Map<String, Object?>>('/api/devices');
  if (!_ok(response.statusCode) || response.data == null) {
    return const [];
  }
  final devices =
      (response.data!['devices'] as List?)?.cast<Map<String, Object?>>() ?? [];
  return devices.map(DeviceView.fromJson).toList();
});

/// Mints a single-use pairing code, valid for five minutes.
///
/// The response carries everything a device needs to find and trust this server: every
/// candidate LAN URL, the certificate fingerprint to pin, and the code. It is offered
/// as a QR *and* as text, because the code's alphabet was chosen to be typed (no
/// `0`/`O`/`1`/`I`) and a desktop without a camera has to be able to join too.
class RemoteAccessRepository {
  RemoteAccessRepository(this._dio);

  final Dio _dio;

  Future<PairingCodeResponse> mintPairingCode() async {
    final response = await _dio.post<Map<String, Object?>>('/api/pair/code');
    if (!_ok(response.statusCode) || response.data == null) {
      throw Exception(
        _errorMessage(response.data) ??
            'Could not create a pairing code (${response.statusCode}).',
      );
    }
    return PairingCodeResponse.fromJson(response.data!);
  }

  Future<void> revoke(String deviceId) async {
    final response = await _dio.delete<Map<String, Object?>>(
      '/api/devices/$deviceId',
    );
    if (!_ok(response.statusCode)) {
      throw Exception(
        _errorMessage(response.data) ?? 'Could not remove the device.',
      );
    }
  }
}

final remoteAccessRepositoryProvider = Provider<RemoteAccessRepository>(
  (ref) => RemoteAccessRepository(ref.watch(dioProvider)),
);

/// A non-2xx does not throw -- dio hands back the body so a NelleError can be read off
/// it -- so the status must be checked before the body is believed. Parsing an error
/// body as a settings payload yields silent nonsense.
bool _ok(int? status) => status != null && status >= 200 && status < 300;

String? _errorMessage(Map<String, Object?>? body) {
  final error = body?['error'];
  return error is Map && error['message'] is String
      ? error['message'] as String
      : null;
}

/// What the pairing QR encodes.
///
/// Everything a device needs to **find** the server (every candidate LAN URL, because
/// the server cannot know which one the device can see) and to **trust** it (the
/// certificate fingerprint, travelling out-of-band, which is what makes the pin
/// pre-shared rather than trust-on-first-use). Drop either and the QR is decorative.
///
/// A named function rather than an expression buried in the widget, because this is the
/// part that has to be *right*: a QR that renders but encodes nonsense looks exactly
/// like one that works.
String pairingQrData(PairingPayload payload) => jsonEncode(payload.toJson());
