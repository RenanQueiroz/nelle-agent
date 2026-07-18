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

/// One place a Settings tap can land. The phone list and the desktop sidebar both render
/// from this, so the two layouts cannot drift — same ids, same keys
/// (`k-settings-section-<id>`), same icons, same destinations.
class _Destination {
  const _Destination({
    required this.id,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.builder,
  });

  final String id;
  final String title;
  final String subtitle;
  final IconData icon;

  /// Builds the destination — pushed standalone on a phone (`embedded: false`), hosted
  /// in the right pane on a desktop (`embedded: true`).
  final Widget Function(bool embedded) builder;
}

class _Group {
  const _Group({
    required this.title,
    required this.subtitle,
    required this.railSubtitle,
    required this.destinations,
  });

  final String title;
  final String subtitle;

  /// The sidebar's short form of [subtitle] — it must survive 256px without wrapping
  /// into a paragraph or ellipsizing into noise.
  final String railSubtitle;

  final List<_Destination> destinations;
}

/// The glyph for a **schema-rendered** section, by slug. Served sections carry no icon —
/// the schema describes fields, not chrome — so the mapping is the client's, with a
/// neutral fallback for any slug a newer server invents.
IconData _sectionIcon(String slug) => switch (slug) {
  'titles' => FLucideIcons.type,
  'attachments' => FLucideIcons.paperclip,
  'instructions' => FLucideIcons.scrollText,
  'network' => FLucideIcons.network,
  'reasoning' => FLucideIcons.brain,
  'runtime' => FLucideIcons.gauge,
  'display' => FLucideIcons.monitor,
  'appearance' => FLucideIcons.palette,
  _ => FLucideIcons.slidersHorizontal,
};

/// Settings: every section the server serves, plus the ones that belong to this device.
///
/// The groups are listed apart on purpose. Someone changing a setting on their phone must
/// not expect their desktop to change, and the only honest way to say which is which is
/// to say it: **Settings** follow you, **This server** is shared, **This device** stays.
///
/// Responsive like the workbench: narrow renders the grouped list and pushes each
/// destination as its own screen; wide renders a sidebar and hosts the selected
/// destination beside it, because a 560px phone column centered in a desktop window
/// wastes the screen and buries three-field forms behind navigation.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key, this.initialSection});

  /// A destination id to land on (`/settings?section=<id>`), so a CTA elsewhere in the
  /// app — "add a model", "install llama.cpp" — can open the right screen, not the hub.
  /// Wide preselects the pane; narrow pushes the destination over the list, so back
  /// still returns somewhere sensible.
  final String? initialSection;

  static const _twoPaneBreakpoint = 760.0;

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  String? _selectedId;

  @override
  void initState() {
    super.initState();
    _selectedId = widget.initialSection;
    final target = widget.initialSection;
    if (target != null) {
      // Narrow lands as list + pushed destination. Deferred a frame because pushing
      // needs a laid-out Navigator; only static destinations can be deep-linked before
      // the schema loads, and the four CTAs that use this are all static.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        final wide =
            MediaQuery.sizeOf(context).width >=
            SettingsScreen._twoPaneBreakpoint;
        if (wide) return;
        final sections =
            ref.read(serverSettingsSchemaProvider).valueOrNull ?? const [];
        final destination = [
          for (final group in _groups(sections)) ...group.destinations,
        ].where((d) => d.id == target).firstOrNull;
        if (destination == null) return;
        Navigator.of(context).push(
          MaterialPageRoute<void>(builder: (_) => destination.builder(false)),
        );
      });
    }
  }

  List<_Group> _groups(List<SettingsSection> serverSections) => [
    _Group(
      title: 'Settings',
      subtitle: 'These follow you to every device.',
      railSubtitle: 'Follow you everywhere.',
      destinations: [
        for (final section in serverSections)
          _Destination(
            id: section.slug,
            title: section.title,
            subtitle: section.description ?? '',
            icon: _sectionIcon(section.slug),
            builder: (embedded) => SettingsSectionScreen(
              section: section,
              scope: SettingsScope(slug: section.slug, isDevice: false),
              embedded: embedded,
            ),
          ),
      ],
    ),
    _Group(
      title: 'This server',
      subtitle: 'The machine Nelle runs on. Shared by every paired device.',
      railSubtitle: 'Shared by every device.',
      destinations: [
        // Administration, not preference: llama.cpp itself, and the models it can load.
        // A paired phone may do all of this -- only pairing and device management are
        // loopback-only -- which is the point, because the server is elsewhere.
        // Named for the thing, not the abstraction. The served `runtime` settings group
        // is *also* called Runtime -- it is llama.cpp's launch limits -- and two rows
        // called Runtime two hundred pixels apart, meaning different things, is a bug
        // you only see by looking at the screen. Its title comes from the server, and
        // special-casing it here would throw the schema away, so this one gets the more
        // specific name. (The id is `llamacpp`, not `runtime`, for the same reason: the
        // served `runtime` group already produces `k-settings-section-runtime`, and two
        // widgets with one ValueKey is a bug you only see by tapping it.)
        _Destination(
          id: 'llamacpp',
          title: 'llama.cpp',
          subtitle: 'Install, start and stop it. See its log.',
          icon: FLucideIcons.cpu,
          builder: (embedded) => RuntimeScreen(embedded: embedded),
        ),
        _Destination(
          id: 'models',
          title: 'Models',
          subtitle: 'The models.ini catalog, and what they cost on disk.',
          icon: FLucideIcons.box,
          builder: (embedded) => ModelsScreen(embedded: embedded),
        ),
        // Host tools live here, not under Settings: they are a gate on *the server's*
        // unsandboxed shell, not a preference of the user's. Custom rather than
        // schema-rendered because the registry can express a boolean but not "this one
        // may only be turned on after you have read something".
        _Destination(
          id: 'host-tools',
          title: 'Host tools',
          subtitle: 'Let the model read files and run shell commands.',
          icon: FLucideIcons.terminal,
          builder: (embedded) => HostToolsScreen(embedded: embedded),
        ),
      ],
    ),
    _Group(
      title: 'This device',
      subtitle: 'Stays here. Not shared with your other devices.',
      railSubtitle: 'Only this device.',
      destinations: [
        // Device sections are described with the *same types* as the server's and
        // rendered by the *same widget*. If a device setting ever needs its own UI
        // here, the renderer is wrong.
        for (final section in deviceSettingsSections)
          _Destination(
            id: section.slug,
            title: section.title,
            subtitle: section.description ?? '',
            icon: _sectionIcon(section.slug),
            builder: (embedded) => SettingsSectionScreen(
              section: section,
              scope: SettingsScope(slug: section.slug, isDevice: true),
              embedded: embedded,
            ),
          ),
        // A pairing is a flow, not a field, so the server connection is a screen of
        // its own rather than a schema-rendered section.
        //
        // Named "Connection", not "Server": it is *this device's relationship to* a
        // server, and there is now a "This server" heading above that administers one.
        // Two rows called Server on one screen reads as a typo.
        _Destination(
          id: 'connection',
          title: 'Connection',
          subtitle: 'Which Nelle this app talks to, and pairing.',
          icon: FLucideIcons.link,
          builder: (embedded) => ConnectionScreen(embedded: embedded),
        ),
      ],
    ),
  ];

  void _back() => context.canPop() ? context.pop() : context.go('/');

  @override
  Widget build(BuildContext context) {
    final sections = ref.watch(serverSettingsSchemaProvider);
    final groups = _groups(sections.valueOrNull ?? const []);
    // MediaQuery, not LayoutBuilder: the sidebar is the *scaffold's* slot, so the
    // decision has to be made above the scaffold. Rebuilds on window resize.
    final wide =
        MediaQuery.sizeOf(context).width >= SettingsScreen._twoPaneBreakpoint;

    if (wide) {
      // No screen-level header: the back affordance lives in the sidebar beside the
      // "Settings" title — the sidebar is the navigation surface, so leaving is a
      // navigation act — and the pane's own heading names the section.
      return FScaffold(
        childPad: false,
        sidebar: _sidebar(groups),
        child: _pane(groups, sections),
      );
    }
    return FScaffold(
      childPad: false,
      header: FHeader.nested(
        title: const Text('Settings'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-settings-back'),
            onPress: _back,
          ),
        ],
      ),
      child: _list(groups, sections),
    );
  }

  // --- wide: sidebar + hosted destination -----------------------------------------------

  _Destination? _selected(List<_Group> groups) {
    final destinations = [for (final g in groups) ...g.destinations];
    return destinations.where((d) => d.id == _selectedId).firstOrNull ??
        destinations.firstOrNull;
  }

  Widget _sidebar(List<_Group> groups) {
    final selected = _selected(groups);
    return FSidebar(
      header: Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
        child: Row(
          children: [
            FButton.icon(
              key: const ValueKey('k-settings-back'),
              variant: FButtonVariant.ghost,
              size: FButtonSizeVariant.sm,
              onPress: _back,
              child: const Icon(FLucideIcons.arrowLeft, size: 18),
            ),
            const SizedBox(width: 6),
            const Text(
              'Settings',
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
          ],
        ),
      ),
      children: [
        for (final group in groups)
          if (group.destinations.isNotEmpty)
            FSidebarGroup(
              label: _GroupHeading(
                title: group.title,
                // The full sentence belongs to the phone list; at rail width it
                // ellipsizes into noise, so the rail gets the short form.
                subtitle: group.railSubtitle,
              ),
              children: [
                for (final destination in group.destinations)
                  FSidebarItem(
                    key: ValueKey('k-settings-section-${destination.id}'),
                    icon: Icon(destination.icon),
                    label: Text(destination.title),
                    selected: destination.id == selected?.id,
                    onPress: () => setState(() => _selectedId = destination.id),
                  ),
              ],
            ),
      ],
    );
  }

  Widget _pane(
    List<_Group> groups,
    AsyncValue<List<SettingsSection>> sections,
  ) {
    final selected = _selected(groups);
    return switch ((selected, sections)) {
      (final _Destination destination?, _) => KeyedSubtree(
        // Keyed by destination so switching sections resets scroll and any
        // widget-local state, exactly as a push would have.
        key: ValueKey('k-settings-pane-${destination.id}'),
        child: destination.builder(true),
      ),
      (_, AsyncError(:final error)) => Center(
        child: Text(
          '$error',
          key: const ValueKey('k-settings-error'),
          style: TextStyle(color: Theme.of(context).colorScheme.error),
        ),
      ),
      _ => const Center(child: CircularProgressIndicator()),
    };
  }

  // --- narrow: the grouped list, destinations pushed -------------------------------------

  Widget _list(
    List<_Group> groups,
    AsyncValue<List<SettingsSection>> sections,
  ) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: ListView(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 8),
          children: [
            for (final (index, group) in groups.indexed) ...[
              if (index > 0) const SizedBox(height: 20),
              _GroupHeading(title: group.title, subtitle: group.subtitle),
              // The schema group renders its load state where its tiles will appear.
              if (index == 0 && sections is! AsyncData)
                switch (sections) {
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
              for (final destination in group.destinations)
                FTile(
                  key: ValueKey('k-settings-section-${destination.id}'),
                  onPress: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (context) => destination.builder(false),
                    ),
                  ),
                  prefix: Icon(destination.icon),
                  title: Text(destination.title),
                  subtitle: destination.subtitle.isEmpty
                      ? null
                      : Text(
                          destination.subtitle,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                  suffix: const Icon(FLucideIcons.chevronRight, size: 16),
                ),
            ],
          ],
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
      padding: const EdgeInsets.fromLTRB(8, 12, 8, 6),
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
