import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/conversation_message.dart';
import 'chat_controller.dart';
import 'context_bar.dart';
import 'message_bubble.dart';

/// The chat detail pane for one conversation: header + context bar + transcript.
/// The composer + streaming land in the next step.
class ChatView extends ConsumerWidget {
  const ChatView({super.key, required this.conversationId, this.onBack});

  final String conversationId;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(chatControllerProvider(conversationId));
    final state = async.valueOrNull;

    return Column(
      children: [
        FHeader.nested(
          prefixes: [
            if (onBack != null)
              FHeaderAction(
                icon: const Icon(FLucideIcons.arrowLeft),
                onPress: onBack,
              ),
          ],
          title: Text(
            state?.title ?? 'Chat',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        if (state != null) ContextBar(usage: state.context),
        const Divider(height: 1),
        Expanded(
          child: switch (async) {
            AsyncData(:final value) => _Transcript(messages: value.messages),
            AsyncError(:final error) => _ChatError(
              message: '$error',
              onRetry: () => ref
                  .read(chatControllerProvider(conversationId).notifier)
                  .reload(),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ],
    );
  }
}

class _Transcript extends StatelessWidget {
  const _Transcript({required this.messages});

  final List<ConversationMessage> messages;

  @override
  Widget build(BuildContext context) {
    if (messages.isEmpty) {
      return const Center(child: Text('No messages yet.'));
    }
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: messages.length,
      itemBuilder: (context, i) => MessageBubble(message: messages[i]),
    );
  }
}

class _ChatError extends StatelessWidget {
  const _ChatError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('Couldn’t load this chat', textAlign: TextAlign.center),
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
