import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../api/settings_schema.dart';
import '../connection/connection_screen.dart';
import 'device_settings.dart';
import 'settings_controller.dart';
import 'settings_section_screen.dart';

/// Settings: every section the server serves, plus the ones that belong to this device.
///
/// The two are listed apart on purpose. Someone changing a setting on their phone must
/// not expect their desktop to change, and the only honest way to say which is which is
/// to say it: **Settings** follow you, **This device** does not.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sections = ref.watch(serverSettingsSchemaProvider);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('Settings'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-settings-back'),
            onPress: () => context.canPop() ? context.pop() : context.go('/'),
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(
            padding: const EdgeInsets.symmetric(vertical: 8),
            children: [
              const _GroupHeading(
                title: 'Settings',
                subtitle: 'These follow you to every device.',
              ),
              switch (sections) {
                AsyncData(:final value) => Column(
                  children: [
                    for (final section in value)
                      _SectionTile(
                        key: ValueKey('k-settings-section-${section.slug}'),
                        title: section.title,
                        subtitle: section.description,
                        onPress: () => _open(context, section, isDevice: false),
                      ),
                  ],
                ),
                AsyncError(:final error) => Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(
                    '$error',
                    key: const ValueKey('k-settings-error'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
                _ => const Padding(
                  padding: EdgeInsets.all(24),
                  child: Center(child: CircularProgressIndicator()),
                ),
              },

              const SizedBox(height: 20),
              const _GroupHeading(
                title: 'This device',
                subtitle: 'Stays here. Not shared with your other devices.',
              ),
              // Device sections are described with the *same types* as the server's and
              // rendered by the *same widget*. If a device setting ever needs its own UI
              // here, the renderer is wrong.
              for (final section in deviceSettingsSections)
                _SectionTile(
                  key: ValueKey('k-settings-section-${section.slug}'),
                  title: section.title,
                  subtitle: section.description,
                  onPress: () => _open(context, section, isDevice: true),
                ),
              // A pairing is a flow, not a field, so the server connection is a screen of
              // its own rather than a schema-rendered section.
              _SectionTile(
                key: const ValueKey('k-settings-section-connection'),
                title: 'Server',
                subtitle: 'Which Nelle this app talks to, and pairing.',
                onPress: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (context) => const ConnectionScreen(),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _open(
    BuildContext context,
    SettingsSection section, {
    required bool isDevice,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => SettingsSectionScreen(
          section: section,
          scope: SettingsScope(slug: section.slug, isDevice: isDevice),
        ),
      ),
    );
  }
}

class _GroupHeading extends StatelessWidget {
  const _GroupHeading({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.5,
            ),
          ),
          Text(
            subtitle,
            style: TextStyle(
              fontSize: 11,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionTile extends StatelessWidget {
  const _SectionTile({
    super.key,
    required this.title,
    required this.onPress,
    this.subtitle,
  });

  final String title;
  final String? subtitle;
  final VoidCallback onPress;

  @override
  Widget build(BuildContext context) => FTile(
    onPress: onPress,
    title: Text(title),
    subtitle: subtitle == null
        ? null
        : Text(subtitle!, maxLines: 2, overflow: TextOverflow.ellipsis),
    suffix: const Icon(FLucideIcons.chevronRight, size: 16),
  );
}
