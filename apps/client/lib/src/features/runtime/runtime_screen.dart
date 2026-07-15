import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/runtime_status.dart';
import '../../api/generated/models/runtime_status_install_mode.dart';
import '../models/router_models_notifier.dart';
import 'install_screen.dart';
import 'runtime_controller.dart';
import 'runtime_logs.dart';

/// Settings > This server > **Runtime**: llama.cpp itself.
///
/// Note what is *not* here. `modelsMax` and `sleepIdleSeconds` are the `runtime` **settings
/// group** and already render from the served schema — `GET /api/runtime` merely *reports*
/// them. Growing a second editor for them here is the duplication that `apps/web`'s
/// `HAND_BUILT_ELSEWHERE` list exists to prevent, and this client is the one that got it right.
class RuntimeScreen extends ConsumerWidget {
  const RuntimeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(runtimeStatusProvider);
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('llama.cpp'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-runtime-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
        suffixes: [
          FHeaderAction(
            key: const ValueKey('k-runtime-refresh'),
            icon: const Icon(FLucideIcons.refreshCw),
            onPress: ref.read(runtimeStatusProvider.notifier).refresh,
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: switch (status) {
            AsyncData(:final value) => _Body(status: value),
            AsyncError(:final error) => Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '$error',
                    key: const ValueKey('k-runtime-error'),
                    textAlign: TextAlign.center,
                    style: TextStyle(color: theme.colorScheme.error),
                  ),
                  const SizedBox(height: 12),
                  FButton(
                    onPress: ref.read(runtimeStatusProvider.notifier).refresh,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.status});

  final RuntimeStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
      children: [
        _StatusRow(status: status),
        const SizedBox(height: 12),
        const _Capacity(),

        // Why the last start failed. `apps/web` has never shown this, though the API has
        // always answered it -- so a runtime that would not come up said nothing at all.
        if (status.lastError != null) ...[
          const SizedBox(height: 12),
          Container(
            key: const ValueKey('k-runtime-last-error'),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: theme.colorScheme.errorContainer,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  FLucideIcons.triangleAlert,
                  size: 16,
                  color: theme.colorScheme.error,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    status.lastError!,
                    style: TextStyle(
                      fontSize: 12,
                      color: theme.colorScheme.onErrorContainer,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],

        const SizedBox(height: 20),
        _Field(label: 'Version', value: _version(status), mono: true),
        _Field(label: 'Install mode', value: _installMode(status)),
        _Field(
          label: 'Binary',
          value: status.binaryPath ?? 'Not installed',
          mono: true,
        ),
        _Field(label: 'Log', value: status.logPath, mono: true),
        _Field(label: 'Address', value: '${status.host}:${status.port}'),
        _Field(label: 'Data dir', value: status.dataDir, mono: true),
        _Field(label: 'Working dir', value: status.workspaceDir, mono: true),

        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: FButton(
                key: const ValueKey('k-runtime-start'),
                onPress: status.installed && !status.running
                    ? ref.read(runtimeStatusProvider.notifier).start
                    : null,
                child: const Text('Start'),
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: FButton(
                key: const ValueKey('k-runtime-stop'),
                onPress: status.running
                    ? ref.read(runtimeStatusProvider.notifier).stop
                    : null,
                child: const Text('Stop'),
              ),
            ),
          ],
        ),

        const SizedBox(height: 8),
        FButton(
          key: const ValueKey('k-runtime-install'),
          onPress: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const InstallScreen()),
          ),
          // The label follows `updateAvailable`, not merely `installed`. `apps/web` said
          // "Update" whenever a binary existed, without ever asking whether there was
          // anything to update *to* -- and it never fetched `?latest=1`, so it could not
          // have known.
          child: Text(
            !status.installed
                ? 'Install llama.cpp'
                : status.updateAvailable
                ? 'Update available'
                : 'Rebuild',
          ),
        ),

        const SizedBox(height: 20),
        FTile(
          key: const ValueKey('k-runtime-logs'),
          onPress: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const RuntimeLogsScreen()),
          ),
          title: const Text('llama-server log'),
          subtitle: const Text('Why a model would not load.'),
          suffix: const Icon(FLucideIcons.chevronRight, size: 16),
        ),
      ],
    );
  }

  String _version(RuntimeStatus status) {
    final installed = status.installedVersion;
    if (installed == null) return 'Not installed';
    // On Linux the "version" is a git sha, because Linux builds from master. Do not dress it
    // up as a semver.
    final short = installed.length > 12
        ? installed.substring(0, 12)
        : installed;
    if (!status.updateAvailable) return short;
    final latest = status.latestVersion;
    final latestShort = latest != null && latest.length > 12
        ? latest.substring(0, 12)
        : latest;
    return '$short → $latestShort';
  }

  String _installMode(RuntimeStatus status) => switch (status.installMode) {
    RuntimeStatusInstallMode.sourceMaster => 'Built from source (master)',
    RuntimeStatusInstallMode.githubRelease => 'GitHub release',
    // `external` is a Dart keyword, so the generator renamed it. `LLAMA_SERVER_PATH` is set:
    // the binary is the user's, and Nelle will neither build nor replace it.
    RuntimeStatusInstallMode.valueExternal =>
      'External binary (LLAMA_SERVER_PATH)',
    // The generated enums carry a `$unknown` member, so a mode a newer server invents does not
    // crash an older client -- it just has no sentence yet.
    RuntimeStatusInstallMode.$unknown => 'Unknown',
  };
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({required this.status});

  final RuntimeStatus status;

  @override
  Widget build(BuildContext context) {
    final (label, colour, icon) = switch (status) {
      _ when status.running => (
        'Running on ${status.host}:${status.port}',
        Colors.green,
        FLucideIcons.circleCheck,
      ),
      _ when status.installed => (
        'Installed, stopped',
        Colors.orange,
        FLucideIcons.circlePause,
      ),
      _ => ('Not installed', Colors.blue, FLucideIcons.circleDashed),
    };

    return Row(
      key: const ValueKey('k-runtime-status'),
      children: [
        Icon(icon, size: 18, color: colour),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            label,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
        ),
      ],
    );
  }
}

/// `loaded/max`, straight from the router. A `sleeping` model is still resident — it has been
/// idled out, not evicted — so it counts.
class _Capacity extends ConsumerWidget {
  const _Capacity();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final props = ref.watch(routerPropsProvider).valueOrNull;
    final models = ref.watch(routerModelsProvider).valueOrNull ?? const [];
    final theme = Theme.of(context);

    if (props == null) {
      return Text(
        'Router stopped',
        key: const ValueKey('k-runtime-capacity'),
        style: TextStyle(
          fontSize: 12,
          color: theme.colorScheme.onSurfaceVariant,
        ),
      );
    }

    final loaded = models.where((m) => isRunnableRouterStatus(m.status)).length;
    final loading = models.where((m) => m.status == 'loading').length;
    final max = props.maxInstances;

    return Text(
      max == null
          ? 'Router capacity unavailable'
          : 'Router capacity: $loaded/${max.toInt()} loaded'
                '${loading > 0 ? ', $loading loading' : ''}',
      key: const ValueKey('k-runtime-capacity'),
      style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurfaceVariant),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({required this.label, required this.value, this.mono = false});

  final String label;
  final String value;
  final bool mono;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Flexed, not fixed: a phone is not a narrow desktop, and an unflexed Row is how M6
          // overflowed the composer by 91px on Android.
          Expanded(
            flex: 2,
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            flex: 5,
            child: Text(
              value,
              textAlign: TextAlign.right,
              style: TextStyle(
                fontSize: 12,
                fontFamily: mono ? 'monospace' : null,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
