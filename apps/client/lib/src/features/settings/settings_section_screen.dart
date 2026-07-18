import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/settings_schema.dart';
import 'section_shell.dart';
import 'settings_controller.dart';
import 'settings_fields.dart';

/// One settings section, rendered from its schema.
///
/// This widget knows what a `select` is. It must never know what a *title mode* is.
/// Every label, help string, bound, option and default arrives from the source, which is
/// why a new server setting appears here with no client release — and why the same code
/// draws the server's sections and this device's.
class SettingsSectionScreen extends ConsumerWidget {
  const SettingsSectionScreen({
    super.key,
    required this.section,
    required this.scope,
    this.embedded = false,
  });

  final SettingsSection section;
  final SettingsScope scope;

  /// Rendered inside the two-pane settings screen (desktop) rather than pushed (phone).
  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final values = ref.watch(settingsValuesProvider(scope));
    final draft = ref.watch(settingsDraftProvider(scope));
    final notifier = ref.read(settingsDraftProvider(scope).notifier);
    final theme = Theme.of(context);

    return SectionShell(
      title: section.title,
      embedded: embedded,
      backKey: const ValueKey('k-settings-section-back'),
      child: switch (values) {
        AsyncData(:final value) => ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
          children: [
            if (section.description != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text(
                  section.description!,
                  style: TextStyle(
                    fontSize: 12,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),

            for (final field in section.fields) ...[
              SettingsFieldControl(
                field: field,
                // The draft wins, then what the source holds, then the field's own
                // default. A field the source has never stored is not missing -- it
                // is simply at its default, which is what a fresh install is.
                value: draft.values.containsKey(field.key)
                    ? draft.values[field.key]
                    : value[field.key],
                onChanged: (next) => notifier.edit(field.key, next),
              ),
              // The server said *which* field it refused (`error.detail`), so the
              // sentence goes under that control. At the bottom of a nine-field form
              // it would leave the user to guess which one it meant.
              if (draft.errorField == field.key && draft.error != null)
                _SaveError(
                  key: ValueKey('k-settings-error-${field.key}'),
                  message: draft.error!,
                ),
            ],

            // A refusal about the group as a whole, or a transport failure: it names
            // no field, so it goes at the bottom.
            if (draft.error != null && draft.errorField == null)
              _SaveError(
                key: const ValueKey('k-settings-save-error'),
                message: draft.error!,
              ),

            const SizedBox(height: 16),
            FButton(
              key: const ValueKey('k-settings-save'),
              onPress: draft.dirty && !draft.saving ? notifier.save : null,
              child: Text(
                draft.saving
                    ? 'Saving…'
                    : draft.saved
                    ? 'Saved'
                    : 'Save',
              ),
            ),
          ],
        ),
        AsyncError(:final error) => Padding(
          padding: const EdgeInsets.all(16),
          child: Text(
            '$error',
            key: const ValueKey('k-settings-values-error'),
            style: TextStyle(color: theme.colorScheme.error),
          ),
        ),
        _ => const Center(child: CircularProgressIndicator()),
      },
    );
  }
}

class _SaveError extends StatelessWidget {
  const _SaveError({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 4),
      child: Row(
        children: [
          Icon(FLucideIcons.circleX, size: 14, color: scheme.error),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              // The source's own sentence, verbatim.
              message,
              style: TextStyle(fontSize: 12, color: scheme.error),
            ),
          ),
        ],
      ),
    );
  }
}
