import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/runtime_status_install_mode.dart';
import 'runtime_controller.dart';

/// Watches llama.cpp get onto the machine — and what "onto the machine" *means* is the whole
/// reason this screen's copy is not fixed. On **Linux** an install is a `git clone` plus a full
/// cmake compile (minutes); on **macOS/Windows** it is a prebuilt release download (seconds). The
/// narration was written for the first and shown to everyone, which is wrong on a Mac — so every
/// user-facing string here is chosen from [_InstallCopy] by the [RuntimeStatusInstallMode].
///
/// Either way the work happens server-side and is streamed, because a silent await fails three
/// ways at once: the user cannot tell whether it is working, the output is discarded, and a client
/// with a receive timeout reports failure while the work carries on. The stream lives in
/// [installControllerProvider], not in this widget: navigating away must not kill it, and there is
/// no way to re-attach to one already in flight.
class InstallScreen extends ConsumerWidget {
  const InstallScreen({super.key, required this.mode});

  /// How this platform installs — a source build, a release download, or an external binary.
  /// Comes from `RuntimeStatus.installMode`, handed down by the runtime screen.
  final RuntimeStatusInstallMode mode;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final install = ref.watch(installControllerProvider);
    final theme = Theme.of(context);
    final copy = _InstallCopy.of(mode);

    return FScaffold(
      header: FHeader.nested(
        title: Text(install.running ? copy.runningTitle : copy.idleTitle),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-install-back'),
            // Leaving does not stop the build. It is a server-side compile, and the stream is
            // held by a provider rather than by this screen.
            onPress: Navigator.of(context).pop,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _Banner(install: install, copy: copy),
          Expanded(
            child: install.lines.isEmpty && !install.running
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        copy.idleText,
                        key: const ValueKey('k-install-idle'),
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  )
                : _Console(install: install),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                // The revert path. llama.cpp floats to latest by design, so when a fresh
                // install goes bad the recovery is stepping back to what worked — the
                // server records `previousVersion` exactly for this button.
                if (_revertTarget(ref, install) case final previous?)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: FButton(
                      key: const ValueKey('k-install-revert'),
                      variant: .secondary,
                      onPress: () => ref
                          .read(installControllerProvider.notifier)
                          .start(version: previous),
                      child: Text('Reinstall ${_shortVersion(previous)}'),
                    ),
                  ),
                FButton(
                  key: const ValueKey('k-install-start'),
                  onPress: install.running
                      ? null
                      : ref.read(installControllerProvider.notifier).start,
                  child: Text(
                    install.running
                        ? copy.runningButton
                        : install.finished
                        ? copy.againButton
                        : 'Install',
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The version to offer as a revert target: only after a failed attempt, and only when the
/// server actually recorded a *different* previous version to step back to.
String? _revertTarget(WidgetRef ref, InstallState install) {
  if (install.running || install.error == null) return null;
  final status = ref.watch(runtimeStatusProvider).valueOrNull;
  final previous = status?.previousVersion;
  if (previous == null || previous == status?.installedVersion) return null;
  return previous;
}

/// A git sha reads as noise at full length; a release tag is already short.
String _shortVersion(String version) =>
    version.length > 12 ? version.substring(0, 12) : version;

class _Banner extends StatelessWidget {
  const _Banner({required this.install, required this.copy});

  final InstallState install;
  final _InstallCopy copy;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    // Only `runtime.install.failed` means failure. Not stderr, not an exit code the user saw
    // scroll past — the server says so, or it did not happen.
    if (install.error != null) {
      return Container(
        key: const ValueKey('k-install-failed'),
        color: theme.colorScheme.errorContainer,
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            Icon(
              FLucideIcons.circleX,
              size: 16,
              color: theme.colorScheme.error,
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                install.error!.message,
                style: TextStyle(
                  fontSize: 12,
                  color: theme.colorScheme.onErrorContainer,
                ),
              ),
            ),
          ],
        ),
      );
    }

    if (install.finished) {
      return Container(
        key: const ValueKey('k-install-completed'),
        color: theme.colorScheme.secondaryContainer,
        padding: const EdgeInsets.all(12),
        child: const Row(
          children: [
            Icon(FLucideIcons.circleCheck, size: 16, color: Colors.green),
            SizedBox(width: 8),
            Text('llama.cpp is installed.', style: TextStyle(fontSize: 12)),
          ],
        ),
      );
    }

    if (install.running) {
      return Padding(
        padding: const EdgeInsets.all(12),
        child: Row(
          children: [
            const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 10),
            Text(copy.runningBanner, style: const TextStyle(fontSize: 12)),
          ],
        ),
      );
    }

    return const SizedBox.shrink();
  }
}

/// The user-facing strings for the install flow, chosen by how *this* platform installs. A source
/// build (Linux) and a release download (macOS/Windows) are different acts with different timings,
/// and telling a Mac user their download is a "full cmake compile" that "takes minutes" is simply
/// wrong.
class _InstallCopy {
  const _InstallCopy({
    required this.idleTitle,
    required this.runningTitle,
    required this.idleText,
    required this.runningBanner,
    required this.runningButton,
    required this.againButton,
  });

  final String idleTitle;
  final String runningTitle;
  final String idleText;
  final String runningBanner;
  final String runningButton;
  final String againButton;

  static _InstallCopy of(RuntimeStatusInstallMode mode) => switch (mode) {
    RuntimeStatusInstallMode.sourceMaster => const _InstallCopy(
      idleTitle: 'Install llama.cpp',
      runningTitle: 'Building llama.cpp…',
      idleText:
          'This builds llama.cpp from source — a git clone and a full cmake compile. It takes '
          'several minutes, and every line of it appears here.',
      runningBanner: 'Compiling. This takes minutes.',
      runningButton: 'Building…',
      againButton: 'Build again',
    ),
    RuntimeStatusInstallMode.githubRelease => const _InstallCopy(
      idleTitle: 'Install llama.cpp',
      runningTitle: 'Installing llama.cpp…',
      idleText:
          'This downloads a prebuilt llama.cpp release for your platform — no compiler needed. '
          'It takes a few seconds, and its progress appears here.',
      runningBanner: 'Downloading the release. This takes a moment.',
      runningButton: 'Installing…',
      againButton: 'Reinstall',
    ),
    // `external` (LLAMA_SERVER_PATH), and a mode a newer server might invent. There is nothing for
    // Nelle to install, so say so rather than promise a build that will not happen.
    RuntimeStatusInstallMode.valueExternal ||
    RuntimeStatusInstallMode.$unknown => const _InstallCopy(
      idleTitle: 'llama.cpp',
      runningTitle: 'Checking llama.cpp…',
      idleText:
          'llama.cpp is set by LLAMA_SERVER_PATH — it is yours to manage, so there is nothing '
          'for Nelle to install here.',
      runningBanner: 'Working…',
      runningButton: 'Working…',
      againButton: 'Recheck',
    ),
  };
}

class _Console extends StatelessWidget {
  const _Console({required this.install});

  final InstallState install;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return SingleChildScrollView(
      // A build scrolls; the interesting line is always the last one.
      reverse: true,
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: SelectionArea(
        child: Column(
          key: const ValueKey('k-install-console'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final line in install.lines)
              Text(
                line.line,
                style: TextStyle(
                  fontSize: 11,
                  fontFamily: 'monospace',
                  // A step Nelle echoed (`$ cmake --build …`) is emphasised so ten minutes of
                  // compiler output has some structure. **stderr is not.**
                  //
                  // cmake and git narrate their progress on stderr: a real build here emitted
                  // 820 stdout lines and 2 stderr, and succeeded. Colouring stderr red would
                  // call that working build broken. The failure banner is the only thing that
                  // says a build failed, and it comes from the server.
                  fontWeight: line.line.startsWith(r'$ ')
                      ? FontWeight.w600
                      : FontWeight.normal,
                  color: line.line.startsWith(r'$ ')
                      ? theme.colorScheme.onSurface
                      : theme.colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
