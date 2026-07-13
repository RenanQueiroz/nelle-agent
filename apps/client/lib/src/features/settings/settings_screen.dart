import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../api/settings_schema.dart';
import '../connection/connection_screen.dart';
import '../models/models_screen.dart';
import '../runtime/runtime_screen.dart';
import 'device_settings.dart';
import 'host_tools.dart';
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
                title: 'This server',
                subtitle:
                    'The machine Nelle runs on. Shared by every paired device.',
              ),
              // Administration, not preference: llama.cpp itself, and the models it can load.
              // A paired phone may do all of this -- only pairing and device management are
              // loopback-only -- which is the point, because the server is elsewhere.
              // Named for the thing, not the abstraction. The served `runtime` settings group
              // is *also* called Runtime -- it is llama.cpp's launch limits -- and two rows
              // called Runtime two hundred pixels apart, meaning different things, is a bug you
              // only see by looking at the screen. Its title comes from the server, and
              // special-casing it here would throw the schema away, so this one gets the more
              // specific name.
              //
              // The key is `-llamacpp`, not `-runtime`: the schema tiles are keyed
              // `k-settings-section-${slug}`, and the served `runtime` group produces exactly
              // `k-settings-section-runtime`. Two widgets with one ValueKey in one ListView --
              // and tapping this row opened the *settings group*, silently. Invisible to every
              // test; obvious the moment you tap it.
              _SectionTile(
                key: const ValueKey('k-settings-section-llamacpp'),
                title: 'llama.cpp',
                subtitle: 'Install, start and stop it. See its log.',
                onPress: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (context) => const RuntimeScreen(),
                  ),
                ),
              ),
              _SectionTile(
                key: const ValueKey('k-settings-section-models'),
                title: 'Models',
                subtitle: 'The models.ini catalog, and what they cost on disk.',
                onPress: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (context) => const ModelsScreen(),
                  ),
                ),
              ),
              // Host tools live here, not under Settings: they are a gate on *the server's*
              // unsandboxed shell, not a preference of the user's. Custom rather than
              // schema-rendered because the registry can express a boolean but not "this one
              // may only be turned on after you have read something".
              _SectionTile(
                key: const ValueKey('k-settings-section-host-tools'),
                title: 'Host tools',
                subtitle: 'Let the model read files and run shell commands.',
                onPress: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (context) => const HostToolsScreen(),
                  ),
                ),
              ),

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
              //
              // Named "Connection", not "Server": it is *this device's relationship to* a
              // server, and there is now a "This server" heading above that administers one.
              // Two rows called Server on one screen reads as a typo.
              _SectionTile(
                key: const ValueKey('k-settings-section-connection'),
                title: 'Connection',
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
