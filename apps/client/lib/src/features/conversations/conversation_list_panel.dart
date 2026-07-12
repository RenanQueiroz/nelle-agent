import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../api/generated/models/conversation_list_item.dart';
import '../../api/generated/models/conversation_status.dart';
import 'conversations_notifier.dart';

/// The conversation sidebar: pinned + recent sections, new-chat, delete, and the
/// full match count in the header.
class ConversationListPanel extends ConsumerWidget {
  const ConversationListPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(conversationsProvider);
    final total = async.valueOrNull?.total;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FHeader(
          title: Text(total == null ? 'Chats' : 'Chats ($total)'),
          suffixes: [
            FHeaderAction(
              icon: const Icon(FLucideIcons.squarePen),
              onPress: () => _newChat(context, ref),
            ),
            FHeaderAction(
              icon: const Icon(FLucideIcons.settings),
              onPress: () => context.go('/connection'),
            ),
          ],
        ),
        Expanded(
          child: switch (async) {
            AsyncData(:final value) => _ConversationList(state: value),
            AsyncError(:final error) => _ErrorState(
              message: '$error',
              onRetry: () => ref.read(conversationsProvider.notifier).refresh(),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ],
    );
  }

  Future<void> _newChat(BuildContext context, WidgetRef ref) async {
    try {
      final created = await ref
          .read(conversationsProvider.notifier)
          .createConversation();
      ref.read(selectedConversationIdProvider.notifier).state = created.id;
    } catch (e) {
      if (context.mounted) _toastError(context, 'Could not create chat: $e');
    }
  }
}

class _ConversationList extends ConsumerWidget {
  const _ConversationList({required this.state});

  final ConversationsState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.items.isEmpty) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('No chats yet.', textAlign: TextAlign.center),
        ),
      );
    }
    final selectedId = ref.watch(selectedConversationIdProvider);
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        if (state.pinned.isNotEmpty) ...[
          const _SectionLabel('Pinned'),
          FTileGroup(
            children: [
              for (final c in state.pinned) _tile(context, ref, c, selectedId),
            ],
          ),
          const SizedBox(height: 12),
        ],
        if (state.recent.isNotEmpty) ...[
          const _SectionLabel('Recent'),
          FTileGroup(
            children: [
              for (final c in state.recent) _tile(context, ref, c, selectedId),
            ],
          ),
        ],
        if (state.hasMore)
          Padding(
            padding: const EdgeInsets.all(8),
            child: FButton(
              onPress: state.loadingMore
                  ? null
                  : () => ref.read(conversationsProvider.notifier).loadMore(),
              child: Text(state.loadingMore ? 'Loading…' : 'Load more'),
            ),
          ),
      ],
    );
  }

  FTile _tile(
    BuildContext context,
    WidgetRef ref,
    ConversationListItem c,
    String? selectedId,
  ) {
    final status = _statusLabel(c.status);
    return FTile(
      title: Text(
        c.title.isEmpty ? 'Untitled' : c.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: status == null ? null : Text(status),
      selected: c.id == selectedId,
      onPress: () =>
          ref.read(selectedConversationIdProvider.notifier).state = c.id,
      suffix: FButton.icon(
        onPress: () => _delete(context, ref, c),
        child: const Icon(FLucideIcons.trash2, size: 16),
      ),
    );
  }

  Future<void> _delete(
    BuildContext context,
    WidgetRef ref,
    ConversationListItem c,
  ) async {
    final wasSelected = ref.read(selectedConversationIdProvider) == c.id;
    try {
      await ref.read(conversationsProvider.notifier).deleteConversation(c.id);
      if (wasSelected) {
        ref.read(selectedConversationIdProvider.notifier).state = null;
      }
    } catch (e) {
      if (context.mounted) _toastError(context, 'Delete failed: $e');
    }
  }
}

String? _statusLabel(ConversationStatus status) => switch (status) {
  ConversationStatus.running => 'Running…',
  ConversationStatus.compacting => 'Compacting…',
  ConversationStatus.aborting => 'Stopping…',
  ConversationStatus.unavailable => 'Unavailable',
  _ => null,
};

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.4,
      ),
    ),
  );
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(FLucideIcons.wifiOff, size: 32),
          const SizedBox(height: 12),
          const Text('Can’t reach the server', textAlign: TextAlign.center),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            maxLines: 3,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 12),
          FButton(onPress: onRetry, child: const Text('Retry')),
        ],
      ),
    ),
  );
}

void _toastError(BuildContext context, String message) {
  showFToast(
    context: context,
    icon: const Icon(FLucideIcons.circleX),
    title: Text(message),
  );
}
