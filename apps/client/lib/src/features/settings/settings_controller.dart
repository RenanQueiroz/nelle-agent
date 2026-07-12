import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/settings_schema.dart';
import 'settings_source.dart';

/// The sections a settings screen shows, in the order the server sends them.
///
/// The device-local sections are appended by [settingsSectionsProvider]; the *renderer*
/// cannot tell them apart, which is the whole design.
final serverSettingsSchemaProvider = FutureProvider<List<SettingsSection>>((
  ref,
) async {
  final response = await ref
      .watch(dioProvider)
      .get<Map<String, Object?>>('/api/settings/schema');
  final status = response.statusCode ?? 0;
  if (status < 200 || status >= 300 || response.data == null) {
    // An error body parsed as a schema yields a screen with no sections, which reads as
    // "this server has no settings". Say nothing rather than say that.
    throw Exception('Could not load settings (${response.statusCode}).');
  }
  return SettingsSchema.fromJson(response.data!).sections;
});

/// A section's current values, from whichever source owns it.
final settingsValuesProvider =
    FutureProvider.family<Map<String, Object?>, SettingsScope>((
      ref,
      scope,
    ) async {
      final source = scope.isDevice
          ? ref.watch(deviceSettingsSourceProvider)
          : ref.watch(serverSettingsSourceProvider);
      return source.read(scope.slug);
    });

/// Which source a section belongs to. A slug alone is not enough: `display` is the
/// server's and `appearance` is this device's, and they are rendered identically.
@immutable
class SettingsScope {
  const SettingsScope({required this.slug, required this.isDevice});

  final String slug;
  final bool isDevice;

  @override
  bool operator ==(Object other) =>
      other is SettingsScope &&
      other.slug == slug &&
      other.isDevice == isDevice;

  @override
  int get hashCode => Object.hash(slug, isDevice);
}

/// What the user is editing, per section.
@immutable
class SettingsDraft {
  const SettingsDraft({
    this.values = const {},
    this.saving = false,
    this.error,
    this.errorField,
    this.saved = false,
  });

  /// Only the fields the user has actually touched. An untouched field is not sent, so a
  /// save cannot rewrite a value the user never looked at.
  final Map<String, Object?> values;
  final bool saving;

  /// The source's own sentence.
  final String? error;

  /// The field the source refused, when it said which -- so the sentence can be shown
  /// under that control rather than at the bottom of the form.
  final String? errorField;
  final bool saved;

  bool get dirty => values.isNotEmpty;

  SettingsDraft copyWith({
    Map<String, Object?>? values,
    bool? saving,
    String? error,
    String? errorField,
    bool? saved,
  }) => SettingsDraft(
    values: values ?? this.values,
    saving: saving ?? this.saving,
    error: error,
    errorField: errorField,
    saved: saved ?? this.saved,
  );
}

final settingsDraftProvider =
    NotifierProvider.family<
      SettingsDraftNotifier,
      SettingsDraft,
      SettingsScope
    >(SettingsDraftNotifier.new);

class SettingsDraftNotifier
    extends FamilyNotifier<SettingsDraft, SettingsScope> {
  @override
  SettingsDraft build(SettingsScope arg) => const SettingsDraft();

  /// A draft is what the user is typing, so nothing re-seeds it but the save that made it
  /// stale. Reloading the section's values must not overwrite a half-typed number.
  void edit(String key, Object? value) {
    state = state.copyWith(values: {...state.values, key: value}, saved: false);
  }

  void discard() => state = const SettingsDraft();

  Future<void> save() async {
    if (!state.dirty || state.saving) {
      return;
    }
    state = state.copyWith(saving: true);
    final source = arg.isDevice
        ? ref.read(deviceSettingsSourceProvider)
        : ref.read(serverSettingsSourceProvider);
    try {
      await source.save(arg.slug, state.values);
      // Only now is the draft stale: the values it held are the values in force.
      state = const SettingsDraft(saved: true);
      ref.invalidate(settingsValuesProvider(arg));
    } on SettingsSaveRefused catch (refusal) {
      // The draft survives. Making the user retype what the server refused -- and it
      // refused it *by name* -- would be a second insult.
      state = state.copyWith(
        saving: false,
        error: refusal.message,
        errorField: refusal.fieldKey,
      );
    } catch (error) {
      state = state.copyWith(saving: false, error: '$error');
    }
  }
}
