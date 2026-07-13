import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/settings_schema.dart';
import 'settings_controller.dart';

/// Settings that belong to *this device*, described with the **same types** the server
/// uses — so the same renderer draws them, and adding one costs a `const` entry.
///
/// A setting is device-local when applying it to another device would be wrong or
/// impossible:
///
/// * **Appearance** — `System` follows *that* OS. A phone at night and a desktop in
///   daylight want different answers, so one stored value cannot be right for both.
/// * **Notifications** *(not built)* — permission is granted per device, and wanting them
///   on the phone but not the desktop is the normal case. When it lands it will be a
///   custom section, because a permission prompt is not a field; the slot is here.
///
/// Everything else — instructions, attachments, titles, reasoning, display, runtime — is
/// taste or server behaviour, and follows the user.
const appearanceSlug = 'appearance';
const themeModeKey = 'themeMode';

/// The device's own sections. A `const` list of exactly the type the wire carries.
final SettingsSection appearanceSection = SettingsSection(
  slug: appearanceSlug,
  title: 'Appearance',
  description: 'How Nelle looks on this device.',
  fields: [
    const SelectSettingsField(
      key: themeModeKey,
      label: 'Theme',
      help: 'System follows this device\'s light or dark setting.',
      defaultValue: 'system',
      options: [
        SettingsSelectOption(value: 'system', label: 'System'),
        SettingsSelectOption(value: 'light', label: 'Light'),
        SettingsSelectOption(value: 'dark', label: 'Dark'),
      ],
    ),
  ],
);

final deviceSettingsSections = <SettingsSection>[appearanceSection];

const appearanceScope = SettingsScope(slug: appearanceSlug, isDevice: true);

/// The theme the app is actually in.
///
/// `ThemeMode.system` is the default, and it is why Appearance is device-local at all: it
/// resolves against *this* device's OS.
final themeModeProvider = FutureProvider<ThemeMode>((ref) async {
  // Rebuilt when the section saves, because the save invalidates the values provider.
  final values = await ref.watch(
    settingsValuesProvider(appearanceScope).future,
  );
  return switch (values[themeModeKey]) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    // Anything else -- unset, or a value written by a build that offered more modes --
    // is the system's.
    _ => ThemeMode.system,
  };
});
