import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../models/model_selector.dart';
import 'chat_controller.dart';

/// The message input. Shows a send button when idle and a stop button while a
/// run streams.
class ChatComposer extends ConsumerStatefulWidget {
  const ChatComposer({super.key, required this.conversationId});

  final String conversationId;

  @override
  ConsumerState<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends ConsumerState<ChatComposer> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _send() {
    final text = _controller.text.trim();
    if (text.isEmpty) {
      return;
    }
    _controller.clear();
    ref.read(chatControllerProvider(widget.conversationId).notifier).send(text);
  }

  void _stop() =>
      ref.read(chatControllerProvider(widget.conversationId).notifier).abort();

  @override
  Widget build(BuildContext context) {
    // The server refused the message before it became a turn, so put the text
    // back instead of making the user retype it.
    ref.listen(
      chatControllerProvider(
        widget.conversationId,
      ).select((s) => s.valueOrNull?.refusedMessage),
      (previous, refused) {
        if (refused == null || refused.isEmpty) {
          return;
        }
        _controller
          ..text = refused
          ..selection = TextSelection.collapsed(offset: refused.length);
        ref
            .read(chatControllerProvider(widget.conversationId).notifier)
            .consumeRefusedMessage();
      },
    );

    final running = ref.watch(
      chatControllerProvider(
        widget.conversationId,
      ).select((s) => s.valueOrNull?.running ?? false),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Per-conversation controls: which model answers this chat, and how hard
          // it thinks.
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [ModelSelector(conversationId: widget.conversationId)],
            ),
          ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: FTextField(
                  key: const ValueKey('k-composer-input'),
                  control: FTextFieldControl.managed(controller: _controller),
                  hint: 'Message…',
                  minLines: 1,
                  maxLines: 6,
                  textInputAction: TextInputAction.send,
                  onSubmit: running ? null : (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              running
                  ? FButton.icon(
                      key: const ValueKey('k-composer-stop'),
                      onPress: _stop,
                      child: const Icon(FLucideIcons.square),
                    )
                  : FButton.icon(
                      key: const ValueKey('k-composer-send'),
                      onPress: _send,
                      child: const Icon(FLucideIcons.arrowUp),
                    ),
            ],
          ),
        ],
      ),
    );
  }
}
