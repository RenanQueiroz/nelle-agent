import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../attachments/attach_button.dart';
import '../attachments/paste_to_file.dart';
import '../attachments/attachment_chips.dart';
import '../models/model_selector.dart';
import 'chat_controller.dart';
import 'reasoning_selector.dart';
import 'slash_commands.dart';

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

  /// A slash command Nelle will not forward. The text stays where it is.
  String? _refusal;

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
    final notifier = ref.read(
      chatControllerProvider(widget.conversationId).notifier,
    );

    // `/compact` has its own endpoint, and the chat route will NOT refuse it: it is on
    // the server's allowlist, so sending it as a prompt hands the model the literal text
    // "/compact". Intercepting it is the client's job.
    final instructions = parseCompactCommand(text);
    if (instructions != null) {
      _controller.clear();
      notifier.compact(instructions);
      return;
    }

    // Everything else the server refuses anyway, with a sentence naming the control to
    // use instead. Refusing here says the same thing without a round trip — and the
    // text stays in the box, because it was never sent.
    final registry =
        ref.read(slashCommandsProvider).valueOrNull ?? bundledRegistry;
    final refusal = unsupportedSlashCommandMessage(text, registry);
    if (refusal != null) {
      setState(() => _refusal = refusal);
      return;
    }

    setState(() => _refusal = null);
    _controller.clear();
    notifier.send(text);
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
    // Warm the served registry when the composer mounts, so a refusal does not wait on a
    // round trip the first time it is needed.
    ref.watch(slashCommandsProvider);

    final refusal = _refusal;
    final warning = ref.watch(
      chatControllerProvider(
        widget.conversationId,
      ).select((s) => s.valueOrNull?.runWarning),
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Non-blocking: the run finished. But an answer that stops mid-sentence
          // because the reply budget ran out deserves a sentence saying so.
          if (warning != null)
            Padding(
              key: const ValueKey('k-composer-run-warning'),
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  Icon(
                    FLucideIcons.triangleAlert,
                    size: 14,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      warning,
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          if (refusal != null)
            Padding(
              key: const ValueKey('k-composer-slash-refusal'),
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                children: [
                  Icon(
                    FLucideIcons.info,
                    size: 14,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      refusal,
                      // Legible, not decorative: this sentence is the only thing telling
                      // the user why nothing happened.
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          // Per-conversation controls: which model answers this chat, and how hard
          // it thinks.
          // Only renders when something is attached; an empty row of chrome above every
          // message is noise.
          AttachmentChips(conversationId: widget.conversationId),
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            // Both selectors flex, because a phone is narrower than the sum of what
            // they would like to be: unflexed, this row overflowed by 91 pixels on a
            // Pixel, painting Flutter's yellow-and-black hazard stripes over the
            // composer. A desktop window is wide enough to hide that forever.
            //
            // The model gets the larger share: its label is a full model id and the
            // reasoning label is one short word.
            child: Row(
              children: [
                Expanded(
                  flex: 3,
                  child: ModelSelector(conversationId: widget.conversationId),
                ),
                const SizedBox(width: 8),
                Expanded(
                  flex: 2,
                  child: ReasoningSelector(
                    conversationId: widget.conversationId,
                  ),
                ),
              ],
            ),
          ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              AttachButton(conversationId: widget.conversationId),
              const SizedBox(width: 8),
              Expanded(
                child: PasteToFile(
                  conversationId: widget.conversationId,
                  controller: _controller,
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
