import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/conversation_message_role.dart';
import 'chat_composer.dart';
import 'chat_controller.dart';
import 'context_bar.dart';
import 'message_bubble.dart';

/// The chat detail pane for one conversation: header, context bar, transcript,
/// composer. Streams assistant replies (content + reasoning) into the transcript.
class ChatView extends ConsumerWidget {
  const ChatView({super.key, required this.conversationId, this.onBack});

  final String conversationId;
  final VoidCallback? onBack;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Toast blocking run errors (context overflow, model load failed, ...).
    ref.listen(
      chatControllerProvider(
        conversationId,
      ).select((s) => s.valueOrNull?.runError),
      (prev, next) {
        if (next != null && next != prev && context.mounted) {
          showFToast(
            context: context,
            icon: const Icon(FLucideIcons.circleX),
            title: Text(next),
          );
        }
      },
    );

    final async = ref.watch(chatControllerProvider(conversationId));
    final state = async.valueOrNull;

    return Column(
      children: [
        FHeader.nested(
          prefixes: [
            if (onBack != null)
              FHeaderAction(
                key: const ValueKey('k-chat-back'),
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
            AsyncData(:final value) => _Transcript(
              state: value,
              conversationId: conversationId,
            ),
            AsyncError(:final error) => _ChatError(
              message: '$error',
              onRetry: () => ref
                  .read(chatControllerProvider(conversationId).notifier)
                  .reload(),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
        if (state != null) ChatComposer(conversationId: conversationId),
      ],
    );
  }
}

class _Transcript extends ConsumerStatefulWidget {
  const _Transcript({required this.state, required this.conversationId});

  final ChatState state;
  final String conversationId;

  @override
  ConsumerState<_Transcript> createState() => _TranscriptState();
}

class _TranscriptState extends ConsumerState<_Transcript> {
  final _scroll = ScrollController();

  @override
  void didUpdateWidget(covariant _Transcript oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Keep the newest content in view as deltas stream in.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final items = widget.state.rendered;
    if (items.isEmpty) {
      return const Center(child: Text('No messages yet.'));
    }
    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.all(16),
      itemCount: items.length,
      itemBuilder: (context, i) {
        final message = items[i];
        final isLast = i == items.length - 1;
        final isStreamingAssistant =
            isLast &&
            widget.state.running &&
            message.role == ConversationMessageRole.assistant;
        if (isStreamingAssistant && widget.state.loadingModel) {
          return _LoadingWeights(progress: widget.state.modelLoadProgress);
        }
        if (isStreamingAssistant &&
            message.content.isEmpty &&
            (message.reasoning ?? '').isEmpty) {
          return const _Thinking();
        }
        // `rendered` is messages followed by pending, so anything past the snapshot's
        // messages is an optimistic turn: it has a local id the server has never seen,
        // and asking it to regenerate itself would 404.
        final isPending = i >= widget.state.messages.length;
        final canRegenerate =
            !isPending &&
            !widget.state.running &&
            message.role == ConversationMessageRole.assistant;
        return MessageBubble(
          message: message,
          onRegenerate: canRegenerate
              ? () => ref
                    .read(chatControllerProvider(widget.conversationId).notifier)
                    .regenerate(message.id)
              : null,
        );
      },
    );
  }
}

class _LoadingWeights extends StatelessWidget {
  const _LoadingWeights({this.progress});

  final double? progress;

  @override
  Widget build(BuildContext context) {
    final pct = progress == null
        ? null
        : (progress! * 100).clamp(0, 100).toStringAsFixed(0);
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(
              width: 14,
              height: 14,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 8),
            Text(pct == null ? 'Loading weights…' : 'Loading weights $pct%'),
          ],
        ),
      ),
    );
  }
}

class _Thinking extends StatelessWidget {
  const _Thinking();

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.centerLeft,
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Text(
        '…',
        style: TextStyle(color: Theme.of(context).colorScheme.outline),
      ),
    ),
  );
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
          FButton(
            key: const ValueKey('k-chat-retry'),
            onPress: onRetry,
            child: const Text('Retry'),
          ),
        ],
      ),
    ),
  );
}
