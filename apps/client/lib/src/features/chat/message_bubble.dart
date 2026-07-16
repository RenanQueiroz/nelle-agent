import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_message_role.dart';
import 'markdown_message.dart';
import 'message_attachments.dart';
import 'performance_stats.dart';

/// One rendered message. User turns align right; assistant turns align left with
/// an optional collapsible reasoning block and a model/variant footer.
class MessageBubble extends StatelessWidget {
  const MessageBubble({
    super.key,
    required this.message,
    this.onRegenerate,
    this.onFork,
    this.readingMetric,
    this.generationMetric,
  });

  final ConversationMessage message;

  /// Prompt-processing stats to show **under a user turn** — they belong to the run that
  /// answered it, so the transcript computes them from the paired assistant message (or the
  /// live run) and hands them down. Null hides the row.
  final PerfMetric? readingMetric;

  /// Generation stats to show in an **assistant** footer, from this message's own performance
  /// or the live run. Null hides them.
  final PerfMetric? generationMetric;

  /// Re-answers this turn, keeping the existing answer as a sibling variant. Null when
  /// regenerating makes no sense: a user turn, a reply still streaming, or a run in
  /// flight.
  final VoidCallback? onRegenerate;

  /// Branches a **new conversation** from this message — the same prompt, a different path,
  /// and the original left exactly as it was.
  ///
  /// A **user** turn only, and that is the server's rule, not a UI choice: a fork replays *your*
  /// prompt down a new branch, so there is nothing to fork from the model's answer. (The server
  /// refuses it with `conversation_not_branchable`.) Regenerate is the assistant-side twin: it
  /// re-answers *in place*. Fork leaves and takes the conversation with it.
  final VoidCallback? onFork;

  @override
  Widget build(BuildContext context) {
    if (message.role == ConversationMessageRole.system) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Center(
          child: Text(
            message.content,
            textAlign: TextAlign.center,
            style: const TextStyle(fontStyle: FontStyle.italic, fontSize: 12),
          ),
        ),
      );
    }

    final scheme = Theme.of(context).colorScheme;
    final isUser = message.role == ConversationMessageRole.user;
    final reasoning = message.reasoning;
    final footer = [
      if (message.modelAliasSnapshot != null) message.modelAliasSnapshot!,
      if (message.variantLabel != null) message.variantLabel!,
    ].join(' · ');

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 640),
        child: Column(
          crossAxisAlignment: isUser
              ? CrossAxisAlignment.end
              : CrossAxisAlignment.start,
          children: [
            // What the message carried, above it — the same order the user attached and
            // then typed.
            MessageAttachments(attachments: message.attachments ?? const []),
            if (!isUser && reasoning != null && reasoning.isNotEmpty)
              _ReasoningBlock(text: reasoning, messageId: message.id),
            Container(
              margin: const EdgeInsets.symmetric(vertical: 4),
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser
                    ? scheme.primary.withValues(alpha: 0.12)
                    : scheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12),
              ),
              // The model answers in markdown; the user types text. Rendering a user's
              // own `a * b` as italics would put words in their mouth.
              child: isUser || message.content.isEmpty
                  ? SelectableText(
                      message.content.isEmpty ? '…' : message.content,
                    )
                  : MarkdownMessage(text: message.content),
            ),
            // Prompt-processing stats sit under the user turn they belong to (llama.cpp's UI
            // layout): the run that read this prompt reports them, and pairing keeps them here.
            if (readingMetric != null)
              PerformanceStatsRow(
                key: ValueKey('k-msg-reading-${message.id}'),
                metric: readingMetric!,
                generation: false,
                alignEnd: isUser,
              ),
            if (footer.isNotEmpty ||
                generationMetric != null ||
                onRegenerate != null ||
                onFork != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 6),
                // A Wrap, not a Row: on a narrow window the alias, the three stat badges and
                // the action icons overflow a single line (the 91px composer-overflow lesson).
                child: Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: 8,
                  runSpacing: 4,
                  children: [
                    if (footer.isNotEmpty)
                      Text(
                        footer,
                        style: TextStyle(fontSize: 10, color: scheme.outline),
                      ),
                    if (generationMetric != null)
                      PerformanceStatsRow(
                        key: ValueKey('k-msg-generation-${message.id}'),
                        metric: generationMetric!,
                        generation: true,
                        alignEnd: false,
                      ),
                    if (onFork != null)
                      _FooterAction(
                        actionKey: ValueKey('k-msg-fork-${message.id}'),
                        icon: FLucideIcons.gitBranch,
                        tooltip: 'Branch a new chat from here',
                        onTap: onFork!,
                      ),
                    if (onRegenerate != null)
                      _FooterAction(
                        actionKey: ValueKey('k-msg-regenerate-${message.id}'),
                        icon: FLucideIcons.refreshCw,
                        tooltip: 'Answer again',
                        onTap: onRegenerate!,
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// One small icon in a message footer.
///
/// A `GestureDetector`, not an `IconButton`: this app is forui over a bare `FScaffold` and has no
/// `Material` ancestor, so anything wanting an ink splash throws "No Material widget found" and
/// paints a red box where the control should be.
class _FooterAction extends StatelessWidget {
  const _FooterAction({
    required this.actionKey,
    required this.icon,
    required this.tooltip,
    required this.onTap,
  });

  final Key actionKey;
  final IconData icon;
  final String tooltip;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => FTooltip(
    tipBuilder: (context, _) => Text(tooltip),
    child: GestureDetector(
      key: actionKey,
      behavior: HitTestBehavior.opaque,
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
        child: Icon(
          icon,
          size: 12,
          color: Theme.of(context).colorScheme.outline,
        ),
      ),
    ),
  );
}

class _ReasoningBlock extends StatefulWidget {
  const _ReasoningBlock({required this.text, required this.messageId});

  final String text;
  final String messageId;

  @override
  State<_ReasoningBlock> createState() => _ReasoningBlockState();
}

class _ReasoningBlockState extends State<_ReasoningBlock> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          GestureDetector(
            key: ValueKey('k-msg-reasoning-toggle-${widget.messageId}'),
            behavior: HitTestBehavior.opaque,
            onTap: () => setState(() => _open = !_open),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  _open ? FLucideIcons.chevronDown : FLucideIcons.chevronRight,
                  size: 14,
                  color: scheme.outline,
                ),
                const SizedBox(width: 4),
                Text(
                  'Reasoning',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: scheme.outline,
                  ),
                ),
              ],
            ),
          ),
          if (_open)
            Padding(
              padding: const EdgeInsets.only(top: 4, left: 18),
              // Thinking is model output too, and it is where the model writes its
              // lists and its arithmetic.
              child: MarkdownMessage(
                text: widget.text,
                style: TextStyle(fontSize: 12, color: scheme.outline),
              ),
            ),
        ],
      ),
    );
  }
}
