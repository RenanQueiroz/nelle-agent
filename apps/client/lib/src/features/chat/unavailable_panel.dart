import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_diagnostics.dart';
import '../conversations/conversations_notifier.dart';
import '../conversations/conversations_repository.dart';
import 'chat_controller.dart';

/// A conversation whose Pi session file is gone.
///
/// The Pi session JSONL **is** the conversation's history — SQLite holds only a projection of it.
/// So when the file goes missing or will not parse, the conversation is `unavailable`, and no read
/// path may quietly conjure a replacement: that would be Nelle inventing a history it does not
/// have. Before this, the client rendered a broken chat as an ordinary *empty* one, which told the
/// user their conversation was gone when in fact it was recoverable and sitting right there.
///
/// There are exactly three ways out, and the order matters:
///
/// 1. **Repair** — re-check the file. It succeeds only if the user put it back, because repair
///    never invents a session. It is offered first because it is the only lossless one.
/// 2. **Rebuild** — reconstruct the session from the SQLite projection. It is **lossy**, and the
///    UI must say *what* it loses, or the user cannot make the choice they are being asked to
///    make.
/// 3. **Delete** — from the sidebar, as always.
class UnavailablePanel extends ConsumerStatefulWidget {
  const UnavailablePanel({super.key, required this.conversationId});

  final String conversationId;

  @override
  ConsumerState<UnavailablePanel> createState() => _UnavailablePanelState();
}

class _UnavailablePanelState extends ConsumerState<UnavailablePanel> {
  ConversationDiagnostics? _diagnostics;
  String? _busy;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadDiagnostics();
  }

  Future<void> _loadDiagnostics() async {
    try {
      final diagnostics = await ref
          .read(conversationsRepositoryProvider)
          .diagnostics(widget.conversationId);
      if (mounted) setState(() => _diagnostics = diagnostics);
    } catch (_) {
      // Diagnostics are an explanation, not a prerequisite. Losing them costs a sentence; the
      // two buttons still work, and hiding them because a detail could not be fetched would be
      // the worse failure.
    }
  }

  Future<void> _run(String key, Future<void> Function() action) async {
    setState(() {
      _busy = key;
      _error = null;
    });
    try {
      await action();
      // The conversation is whole again: reload it and the panel goes with it.
      await ref
          .read(chatControllerProvider(widget.conversationId).notifier)
          .reload();
      // **And tell the sidebar.** The list row carries the conversation's `status`, and it does
      // not re-fetch on its own -- so a repaired chat sat there fully restored, composer and all,
      // with "Unavailable" still printed under its name in the sidebar. Found by driving.
      await ref.read(conversationsProvider.notifier).refresh();
    } catch (error) {
      if (mounted) {
        setState(
          () => _error = error is NelleApiException ? error.message : '$error',
        );
      }
    } finally {
      if (mounted) setState(() => _busy = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final diagnostics = _diagnostics;
    final entries = diagnostics?.projectionEntryCount ?? 0;

    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Icon(FLucideIcons.fileWarning, size: 32, color: scheme.error),
              const SizedBox(height: 12),
              Text(
                'This conversation’s history file is missing',
                key: const ValueKey('k-unavailable-title'),
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                // The filesystem's own words. A client cannot say it better, and guessing would
                // send the user to fix the wrong thing.
                diagnostics?.reason ??
                    'Nelle cannot read the file that holds this conversation.',
                key: const ValueKey('k-unavailable-reason'),
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
              ),
              if (diagnostics?.piSessionPath != null) ...[
                const SizedBox(height: 8),
                SelectableText(
                  diagnostics!.piSessionPath!,
                  key: const ValueKey('k-unavailable-path'),
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
              const SizedBox(height: 24),

              // 1. Repair. Lossless, and therefore first.
              FButton(
                key: const ValueKey('k-unavailable-repair'),
                onPress: _busy != null
                    ? null
                    : () => _run(
                        'repair',
                        () => ref
                            .read(conversationsRepositoryProvider)
                            .repair(widget.conversationId),
                      ),
                child: Text(_busy == 'repair' ? 'Checking…' : 'Repair'),
              ),
              const SizedBox(height: 4),
              Text(
                'If you can put the file back, this restores the conversation exactly. '
                'Nelle never invents a history it does not have, so this only works if the '
                'file is really there.',
                style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
              ),
              const SizedBox(height: 20),

              // 2. Rebuild. Lossy, and it must SAY what it loses.
              FButton(
                key: const ValueKey('k-unavailable-rebuild'),
                variant: FButtonVariant.outline,
                onPress: _busy != null
                    ? null
                    : () => _run(
                        'rebuild',
                        () => ref
                            .read(conversationsRepositoryProvider)
                            .rebuild(widget.conversationId),
                      ),
                child: Text(
                  _busy == 'rebuild'
                      ? 'Rebuilding…'
                      : 'Rebuild from saved messages',
                ),
              ),
              const SizedBox(height: 4),
              Text(
                // **Naming the losses is the whole point.** "This is lossy" is not a choice a
                // user can weigh; "you will lose your tool results and your images" is.
                entries > 0
                    ? 'Reconstructs the conversation from the $entries message'
                          '${entries == 1 ? '' : 's'} still in Nelle’s database. '
                          'It is lossy: tool results, image content, compaction summaries and '
                          'regenerated answer variants are not recoverable this way.'
                    : 'Reconstructs the conversation from the messages still in Nelle’s '
                          'database. It is lossy: tool results, image content, compaction '
                          'summaries and regenerated answer variants are not recoverable this '
                          'way.',
                key: const ValueKey('k-unavailable-lossy'),
                style: TextStyle(fontSize: 11, color: scheme.onSurfaceVariant),
              ),

              if (_error != null) ...[
                const SizedBox(height: 20),
                Text(
                  _error!,
                  key: const ValueKey('k-unavailable-error'),
                  style: TextStyle(fontSize: 12, color: scheme.error),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
