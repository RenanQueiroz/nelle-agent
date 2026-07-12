import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../api/api_client.dart';
import '../../core/config.dart';

/// Where a settings group's values are read and written.
///
/// The renderer never knows. `SettingsSection`/`SettingsField` is a *rendering* contract,
/// not "the server's data" — so a section can come off the wire or out of a `const` list
/// in this app, and be drawn by exactly the same widget. What differs is only this.
///
/// That is what makes **Appearance** (device-local) and **Reasoning budgets** (server)
/// the same amount of work, and what makes Notifications, when it lands, a `const`
/// section plus a source rather than a screen.
abstract class SettingsSource {
  /// The group's current values, keyed by field key.
  Future<Map<String, Object?>> read(String slug);

  /// Writes a patch. Returns the values the *source* settled on — which is not always
  /// what was sent: the server coerces, clamps and can refuse.
  Future<Map<String, Object?>> save(String slug, Map<String, Object?> patch);
}

/// Raised when a save is refused.
///
/// Carries the source's own sentence *and* the field it is about. The server puts the
/// offending key in `error.detail`, so the message can be shown under the control that
/// caused it rather than at the bottom of a form, leaving the user to guess which of nine
/// fields it meant.
class SettingsSaveRefused implements Exception {
  const SettingsSaveRefused(this.message, {this.fieldKey});

  final String message;

  /// The field the source refused, when it said. `null` for a refusal about the whole
  /// group, or a transport failure.
  final String? fieldKey;

  @override
  String toString() => message;
}

/// Settings that follow the user: `GET`/`PATCH /api/settings/<slug>`.
class ServerSettingsSource implements SettingsSource {
  const ServerSettingsSource(this._dio);

  final Dio _dio;

  @override
  Future<Map<String, Object?>> read(String slug) async {
    final response = await _dio.get<Map<String, Object?>>(
      '/api/settings/$slug',
    );
    if (!_ok(response.statusCode) || response.data == null) {
      throw SettingsSaveRefused(
        _message(response.data) ??
            'Could not read settings (${response.statusCode}).',
      );
    }
    return response.data!;
  }

  @override
  Future<Map<String, Object?>> save(
    String slug,
    Map<String, Object?> patch,
  ) async {
    final response = await _dio.patch<Map<String, Object?>>(
      '/api/settings/$slug',
      data: patch,
    );
    // A non-2xx does not throw -- dio hands the body back so a NelleError can be read off
    // it -- so the status must be checked before the body is believed. The server's
    // refusal names the field; parsing it as a settings payload would yield silent
    // nonsense instead.
    if (!_ok(response.statusCode) || response.data == null) {
      throw SettingsSaveRefused(
        _message(response.data) ??
            'The server refused the change (${response.statusCode}).',
        fieldKey: _detail(response.data),
      );
    }
    return response.data!;
  }
}

/// Settings that belong to *this* device, in SharedPreferences.
///
/// Not the keystore: these are not secrets, they are preferences. The keys are namespaced
/// by slug so a device group cannot collide with anything else the app stores.
class DeviceSettingsSource implements SettingsSource {
  const DeviceSettingsSource(this._prefs);

  final SharedPreferences _prefs;

  static String _key(String slug, String field) => 'settings.$slug.$field';

  @override
  Future<Map<String, Object?>> read(String slug) async {
    final values = <String, Object?>{};
    final prefix = 'settings.$slug.';
    for (final key in _prefs.getKeys()) {
      if (key.startsWith(prefix)) {
        values[key.substring(prefix.length)] = _prefs.get(key);
      }
    }
    // Missing keys are simply absent, and the caller falls back to the field's own
    // default -- which is what a fresh install is.
    return values;
  }

  @override
  Future<Map<String, Object?>> save(
    String slug,
    Map<String, Object?> patch,
  ) async {
    for (final entry in patch.entries) {
      final key = _key(slug, entry.key);
      final value = entry.value;
      switch (value) {
        case final bool it:
          await _prefs.setBool(key, it);
        case final int it:
          await _prefs.setInt(key, it);
        case final double it:
          await _prefs.setDouble(key, it);
        case final String it:
          await _prefs.setString(key, it);
        case null:
          await _prefs.remove(key);
        default:
          throw SettingsSaveRefused(
            'Cannot store ${value.runtimeType} on this device.',
          );
      }
    }
    return read(slug);
  }
}

final serverSettingsSourceProvider = Provider<SettingsSource>(
  (ref) => ServerSettingsSource(ref.watch(dioProvider)),
);

final deviceSettingsSourceProvider = Provider<SettingsSource>(
  (ref) => DeviceSettingsSource(ref.watch(sharedPreferencesProvider)),
);

bool _ok(int? status) => status != null && status >= 200 && status < 300;

String? _message(Map<String, Object?>? body) {
  final error = body?['error'];
  return error is Map && error['message'] is String
      ? error['message'] as String
      : null;
}

/// `error.detail` is the key of the field the server refused.
String? _detail(Map<String, Object?>? body) {
  final error = body?['error'];
  return error is Map && error['detail'] is String
      ? error['detail'] as String
      : null;
}
