import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/runtime_log_tail.dart';
import 'runtime_repository.dart';

/// llama-server's log tail, **re-read while the screen is open**.
///
/// There is no log *stream* — `GET /api/runtime/logs` is a one-shot read of the last N bytes —
/// so a client that fetches once and stops is a screen you open to find out why llama-server
/// just died, and which cannot show you it dying. That is what `apps/web` does. Poll instead.
///
/// `autoDispose` so the polling stops the moment the screen is closed.
final runtimeLogsProvider = StreamProvider.autoDispose<RuntimeLogTail>((
  ref,
) async* {
  final repo = ref.watch(runtimeRepositoryProvider);
  while (true) {
    yield await repo.logs();
    await Future<void>.delayed(const Duration(seconds: 2));
  }
});

class RuntimeLogsScreen extends ConsumerWidget {
  const RuntimeLogsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final logs = ref.watch(runtimeLogsProvider);
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('llama-server log'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-runtime-logs-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
      ),
      child: switch (logs) {
        AsyncData(:final value) => _LogBody(tail: value),
        AsyncError(:final error) => Center(
          child: Text(
            '$error',
            key: const ValueKey('k-runtime-logs-error'),
            style: TextStyle(color: theme.colorScheme.error),
          ),
        ),
        _ => const Center(child: FCircularProgress.loader()),
      },
    );
  }
}

class _LogBody extends StatelessWidget {
  const _LogBody({required this.tail});

  final RuntimeLogTail tail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (tail.text.isEmpty) {
      return Center(
        child: Text(
          'No llama-server output yet.',
          key: const ValueKey('k-runtime-logs-empty'),
          style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
          child: Text(
            tail.path,
            style: TextStyle(
              fontSize: 11,
              fontFamily: 'monospace',
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        Expanded(
          child: SingleChildScrollView(
            reverse: true,
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: SelectionArea(
              // Plain monospace text, deliberately **not** coloured by severity.
              //
              // An `E` line in this log is not necessarily a failure. A *successful* offline
              // load of a pinned model logs `E get_repo_commit: error: GET failed (404)` and
              // then loads perfectly — that is the cache fallback working exactly as designed,
              // and every pinned model does it on every load. So the single most common `E`
              // here is a model working correctly. Painting it red, or raising a "your runtime
              // has errors" banner off the back of it, would send the user to fix the one thing
              // that is definitely not broken.
              child: Text(
                tail.text,
                key: const ValueKey('k-runtime-logs-text'),
                style: const TextStyle(fontSize: 11, fontFamily: 'monospace'),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
