import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_message_role.dart';
import '../../api/generated/models/tool_call_event.dart';
import 'expandable_card.dart';
import 'footer_bar.dart';
import 'markdown_message.dart';
import 'message_attachments.dart';
import 'performance_stats.dart';
import 'tool_call_card.dart';

/// The message body is a step larger than the footer so the answer stays dominant over it —
/// llama.cpp's hierarchy. Both roles share it so user and assistant stay symmetric.
const _messageBodyStyle = TextStyle(fontSize: 15.5, height: 1.4);

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
    this.modelControl,
    this.variantControl,
    this.toolCalls = const [],
    this.reasoningStreaming = false,
  });

  final ConversationMessage message;

  /// This turn's reasoning is arriving **right now** and the answer has not started. The
  /// card opens itself so the thoughts are watchable, titles itself "Thinking…", and puts
  /// itself away the moment the first answer token lands.
  final bool reasoningStreaming;

  /// The footer's model **dropdown**, injected by the transcript when regenerating this
  /// message is allowed. When null the footer shows the model alias as plain text — a run in
  /// flight, a pending turn, or a user turn. Injected as a widget (rather than built here) so
  /// this bubble stays provider-free and testable.
  final Widget? modelControl;

  /// Prompt-processing stats to show **under a user turn** — they belong to the run that
  /// answered it, so the transcript computes them from the paired assistant message (or the
  /// live run) and hands them down. Null hides the row.
  final PerfMetric? readingMetric;

  /// Generation stats to show in an **assistant** footer, from this message's own performance
  /// or the live run. Null hides them.
  final PerfMetric? generationMetric;

  /// The `‹ N/M ›` variant switcher, injected by the transcript when this answer is one of
  /// several for its prompt. Null → the plain `variant N/M` label (or nothing).
  final Widget? variantControl;

  /// The tool calls this assistant message made, each rendered as an expandable card above the
  /// answer. The transcript passes the live run's calls for a streaming turn and the settled
  /// `message.toolCalls` for a finished one. Empty hides the row.
  final List<ToolCallEvent> toolCalls;

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
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: ExpandableCard(
                  key: ValueKey('k-msg-reasoning-${message.id}'),
                  open: reasoningStreaming,
                  title: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        FLucideIcons.brain,
                        size: 15,
                        color: context.theme.colors.mutedForeground,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        reasoningStreaming ? 'Thinking…' : 'Reasoning',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: context.theme.colors.mutedForeground,
                        ),
                      ),
                    ],
                  ),
                  // Thinking is model output too — where it writes its lists and arithmetic.
                  child: MarkdownMessage(
                    text: reasoning,
                    style: TextStyle(
                      fontSize: 13,
                      color: context.theme.colors.mutedForeground,
                    ),
                  ),
                ),
              ),
            // Tool calls (a model calls tools, then answers), each an expandable card. Empty for
            // a user turn.
            for (final call in toolCalls) ToolCallCard(call: call),
            // The model answers in markdown; the user types text. Rendering a user's own
            // `a * b` as italics would put words in their mouth.
            //
            // The **user** turn is a rounded chip on the right; the **assistant** answer is plain
            // text flush-left (llama.cpp's layout), with no bubble padding so its left edge lines
            // up with the footer beneath it.
            if (isUser)
              Container(
                margin: const EdgeInsets.symmetric(vertical: 4),
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: scheme.primary.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(12),
                ),
                child: SelectableText(
                  message.content,
                  style: _messageBodyStyle,
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: message.content.isEmpty
                    ? SelectableText('…', style: _messageBodyStyle)
                    : MarkdownMessage(
                        text: message.content,
                        style: _messageBodyStyle,
                      ),
              ),
            ..._footerRows(context, isUser),
          ],
        ),
      ),
    );
  }

  /// The footer, laid out as llama.cpp does — up to two `FooterBar` **row-groups**, each of which
  /// sits side-by-side with a `·` when it fits and stacks without separators when it doesn't:
  ///
  /// - **assistant:** `[model · generation-metrics]` then `[variant · actions]` — so a wide window
  ///   is 2 rows and a phone is 3 (the model group stacks, the variant group stays paired).
  /// - **user:** one group, `[reading-metrics · actions]`.
  ///
  /// Every message has at least a copy action, so there is always a footer.
  List<Widget> _footerRows(BuildContext context, bool isUser) {
    final muted = context.theme.colors.mutedForeground;
    final metrics = _metricsSection(isUser);
    final actions = _actionsSection(context, muted);

    final groups = isUser
        ? [
            [?metrics, actions],
          ]
        : [
            [?_modelSection(muted), ?metrics],
            [?_variantSection(muted), actions],
          ];

    final rows = <Widget>[];
    for (var i = 0; i < groups.length; i++) {
      final group = groups[i].whereType<Widget>().toList();
      if (group.isEmpty) continue;
      rows.add(
        Padding(
          padding: EdgeInsets.only(
            top: i == 0 ? 2 : 4,
            bottom: i == groups.length - 1 ? 6 : 0,
          ),
          child: FooterBar(
            key: ValueKey('k-msg-footer${i + 1}-${message.id}'),
            color: muted,
            children: group,
          ),
        ),
      );
    }
    return rows;
  }

  /// The model section (assistant only): the injected dropdown, or the alias as muted text.
  Widget? _modelSection(Color muted) {
    if (message.role == ConversationMessageRole.user) {
      return null;
    }
    final control = modelControl;
    if (control != null) {
      return control;
    }
    final alias = message.modelAliasSnapshot;
    return alias == null
        ? null
        : Text(alias, style: TextStyle(fontSize: 14, color: muted));
  }

  /// Prompt-processing stats under a user turn, generation stats under an assistant one — a
  /// message never has both.
  Widget? _metricsSection(bool isUser) {
    final metric = isUser ? readingMetric : generationMetric;
    if (metric == null) {
      return null;
    }
    return PerformanceStatsRow(
      key: ValueKey('k-msg-${isUser ? 'reading' : 'generation'}-${message.id}'),
      metric: metric,
      generation: !isUser,
      alignEnd: false,
    );
  }

  /// The variant section (assistant only): the `‹ N/M ›` switcher when injected, else the plain
  /// `variant N/M` label (a run in flight, or a settled group the transcript did not pass a
  /// switcher for).
  Widget? _variantSection(Color muted) {
    if (variantControl != null) {
      return variantControl;
    }
    final variant = message.variantLabel;
    return variant == null
        ? null
        : Text(variant, style: TextStyle(fontSize: 14, color: muted));
  }

  /// The action buttons: copy (both roles), then regenerate (assistant) or fork (user).
  Widget _actionsSection(BuildContext context, Color muted) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      _FooterAction(
        actionKey: ValueKey('k-msg-copy-${message.id}'),
        icon: FLucideIcons.copy,
        tooltip: 'Copy message',
        color: muted,
        onTap: () => _copy(context),
      ),
      if (onFork != null)
        _FooterAction(
          actionKey: ValueKey('k-msg-fork-${message.id}'),
          icon: FLucideIcons.gitBranch,
          tooltip: 'Branch a new chat from here',
          color: muted,
          onTap: onFork!,
        ),
      if (onRegenerate != null)
        _FooterAction(
          actionKey: ValueKey('k-msg-regenerate-${message.id}'),
          icon: FLucideIcons.refreshCw,
          tooltip: 'Answer again',
          color: muted,
          onTap: onRegenerate!,
        ),
    ],
  );

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: message.content));
    if (context.mounted) {
      showFToast(
        context: context,
        icon: const Icon(FLucideIcons.check),
        title: const Text('Copied'),
      );
    }
  }
}

/// One small icon in a message footer.
///
/// A ghost `FButton.icon` (forui), not a Material `IconButton`: this app is forui over a bare
/// `FScaffold` with no `Material` ancestor, so an ink-splash widget throws "No Material widget
/// found". Ghost keeps it flat until hover — the same treatment as the variant switcher's arrows,
/// so the whole footer's controls share one look. The explicit `size`/`color` on the `Icon`
/// override the button's own icon theme, keeping the 18px muted glyph the footer wants.
class _FooterAction extends StatelessWidget {
  const _FooterAction({
    required this.actionKey,
    required this.icon,
    required this.tooltip,
    required this.color,
    required this.onTap,
  });

  final Key actionKey;
  final IconData icon;
  final String tooltip;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => FTooltip(
    tipBuilder: (context, _) => Text(tooltip),
    child: FButton.icon(
      key: actionKey,
      size: FButtonSizeVariant.xs,
      variant: FButtonVariant.ghost,
      onPress: onTap,
      child: Icon(icon, size: 18, color: color),
    ),
  );
}
