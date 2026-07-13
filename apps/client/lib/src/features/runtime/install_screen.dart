import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import 'runtime_controller.dart';

/// Watches a llama.cpp build happen.
///
/// On Linux an install is a `git clone` plus a full cmake compile — minutes, sometimes tens
/// of them. Awaiting it silently is what the old route did, and it fails three ways at once:
/// the user has no idea whether it is working, the build's output is discarded, and a client
/// with a receive timeout reports failure while the build carries happily on. So it is
/// narrated, and this is where the narration goes.
///
/// The stream lives in [installControllerProvider], not in this widget: navigating away must
/// not kill a build, and there is no way to re-attach to one already in flight.
class InstallScreen extends ConsumerWidget {
  const InstallScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final install = ref.watch(installControllerProvider);
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: Text(
          install.running ? 'Building llama.cpp…' : 'Install llama.cpp',
        ),
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
          _Banner(install: install),
          Expanded(
            child: install.lines.isEmpty && !install.running
                ? Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                        'On Linux this builds llama.cpp from source — a git clone and a full '
                        'cmake compile. It takes minutes, and every line of it appears here.',
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
            child: FButton(
              key: const ValueKey('k-install-start'),
              onPress: install.running
                  ? null
                  : ref.read(installControllerProvider.notifier).start,
              child: Text(
                install.running
                    ? 'Building…'
                    : install.finished
                    ? 'Build again'
                    : 'Install',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.install});

  final InstallState install;

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
      return const Padding(
        padding: EdgeInsets.all(12),
        child: Row(
          children: [
            SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            SizedBox(width: 10),
            Text(
              'Compiling. This takes minutes.',
              style: TextStyle(fontSize: 12),
            ),
          ],
        ),
      );
    }

    return const SizedBox.shrink();
  }
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
