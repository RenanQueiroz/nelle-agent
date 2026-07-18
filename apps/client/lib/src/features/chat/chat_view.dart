import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_message_role.dart';
import '../../api/generated/models/fork_kind.dart';
import '../../api/generated/models/tool_call_event.dart';
import '../attachments/drop_target.dart';
import '../conversations/conversations_notifier.dart';
import '../conversations/conversations_repository.dart';
import 'chat_composer.dart';
import 'chat_controller.dart';
import 'context_bar.dart';
import 'empty_chat_panel.dart';
import '../settings/display_settings.dart';
import 'message_bubble.dart';
import 'message_model_dropdown.dart';
import 'performance_stats.dart';
import 'tool_call_card.dart';
import 'variant_switcher.dart';
import 'unavailable_panel.dart';

/// The chat detail pane for one conversation: header, context bar, transcript,
/// composer. Streams assistant replies (content + reasoning) into the transcript.
class ChatView extends ConsumerWidget {
  const ChatView({
    super.key,
    required this.conversationId,
    this.onToggleSidebar,
    this.sidebarIcon = FLucideIcons.panelLeft,
  });

  final String conversationId;

  /// The top-left affordance for the chat list: on a phone it opens the sheet sidebar
  /// (hamburger), on a desktop it collapses/reopens the persistent one. Null hides it.
  final VoidCallback? onToggleSidebar;

  final IconData sidebarIcon;

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

    return AttachmentDropTarget(
      conversationId: conversationId,
      child: Column(
        children: [
          FHeader.nested(
            prefixes: [
              if (onToggleSidebar != null)
                FHeaderAction(
                  key: const ValueKey('k-chat-sidebar'),
                  icon: Icon(sidebarIcon),
                  onPress: onToggleSidebar,
                ),
            ],
            title: Text(
              state?.title ?? 'Chat',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (state?.forkKind != null) _BranchedBanner(kind: state!.forkKind!),
          // An unavailable conversation has no context to speak of, and no history to bar.
          if (state != null && !state.unavailable)
            ContextBar(usage: state.context),
          const Divider(height: 1),
          Expanded(
            child: switch (async) {
              // The transcript of an `unavailable` conversation is **empty**, because SQLite holds
              // only a projection and the real history is in the file that is missing. Rendering
              // it as an ordinary empty chat told the user their conversation was gone -- when in
              // fact it is recoverable, and the way to recover it is right here.
              AsyncData(:final value) when value.unavailable =>
                UnavailablePanel(conversationId: conversationId),
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
          // No composer: there is nowhere to send a message to. `capabilities.canSend` is already
          // false, but a disabled box the user can type into and watch do nothing is worse than
          // no box at all.
          if (state != null && !state.unavailable)
            ChatComposer(conversationId: conversationId),
        ],
      ),
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
    final compactNote = widget.state.compactNote;
    // Each prompt's answer variants collapse into **one** rendered unit (the active one, with a
    // `‹ N/M ›` switcher), rather than every variant stacked. Pending turns (a streaming reply)
    // never group — their ids are local and they are not variants of anything yet.
    final units = <_DisplayUnit>[
      ..._groupVariants(
        widget.state.messages,
        widget.state.snapshot.activePathEntryIds,
      ),
      for (final message in widget.state.pending)
        _DisplayUnit.single(message, pending: true),
    ];
    if (units.isEmpty && compactNote == null) {
      // Not a "no messages" shrug: on a fresh install this is where the guided path
      // lives (install llama.cpp → add a model → start it), and on a ready one, a
      // greeting.
      return const EmptyChatPanel();
    }
    final notifier = ref.read(
      chatControllerProvider(widget.conversationId).notifier,
    );
    final running = widget.state.running;
    // Gated on the served `showGenerationStats` display preference.
    final showStats =
        ref.watch(displaySettingsProvider).valueOrNull?.showGenerationStats ??
        true;

    return ListView.builder(
      controller: _scroll,
      padding: const EdgeInsets.all(16),
      itemCount: units.length + (compactNote == null ? 0 : 1),
      itemBuilder: (context, i) {
        // The compaction row is synthesized: `buildConversationMessages` drops compaction
        // entries, so `snapshot.messages` never contains it and reloading would not bring it back.
        if (i == units.length) {
          return _CompactNote(note: compactNote!);
        }
        final unit = units[i];
        final message = unit.message;
        final isLast = i == units.length - 1;
        final isStreamingAssistant =
            unit.pending &&
            isLast &&
            running &&
            message.role == ConversationMessageRole.assistant;
        if (isStreamingAssistant && widget.state.loadingModel) {
          return _LoadingWeights(load: widget.state.modelLoad);
        }
        if (isStreamingAssistant &&
            message.content.isEmpty &&
            (message.reasoning ?? '').isEmpty) {
          return const _Thinking();
        }
        final canRegenerate =
            !unit.pending &&
            !running &&
            message.role == ConversationMessageRole.assistant;
        // A fork replays **your** prompt down a new branch, so it hangs off a *user* turn -- the
        // mirror of regenerate. `canFork` is the server's word (an `unavailable` conversation has
        // no session to branch).
        final canFork =
            !unit.pending &&
            !running &&
            message.role == ConversationMessageRole.user &&
            widget.state.snapshot.capabilities.canFork;

        // Per-message performance stats (llama.cpp layout): prompt processing under the user turn,
        // generation under the assistant. The reading row's data lives on the answer, so a user
        // turn reads it from the unit that follows it.
        PerfMetric? readingMetric;
        PerfMetric? generationMetric;
        if (showStats) {
          if (message.role == ConversationMessageRole.assistant) {
            final live = isStreamingAssistant
                ? widget.state.livePerformance
                : null;
            generationMetric =
                generationMetricOf(live) ??
                generationMetricOf(
                  parseMessagePerformance(message.performance),
                );
          } else if (message.role == ConversationMessageRole.user &&
              i + 1 < units.length &&
              units[i + 1].message.role == ConversationMessageRole.assistant) {
            final answer = units[i + 1].message;
            final answerIsStreaming =
                units[i + 1].pending && (i + 1 == units.length - 1) && running;
            final live = answerIsStreaming
                ? widget.state.livePerformance
                : null;
            readingMetric =
                promptMetricOf(live) ??
                promptMetricOf(parseMessagePerformance(answer.performance));
          }
        }

        // Tool calls: the live run's for the streaming assistant, else the settled message's.
        final toolCalls = message.role == ConversationMessageRole.assistant
            ? (isStreamingAssistant
                  ? widget.state.liveToolCalls
                  : parseToolCalls(message.toolCalls))
            : const <ToolCallEvent>[];

        return MessageBubble(
          message: message,
          readingMetric: readingMetric,
          generationMetric: generationMetric,
          toolCalls: toolCalls,
          // Open while the thoughts stream, and closed by the first answer token.
          reasoningStreaming: isStreamingAssistant && message.content.isEmpty,
          onRegenerate: canRegenerate
              ? () => notifier.regenerate(message.id)
              : null,
          onFork: canFork ? () => _fork(context, ref, message.id) : null,
          // The model indicator becomes a dropdown only when regenerating this answer is allowed;
          // otherwise `MessageBubble` shows the alias as plain text.
          modelControl: canRegenerate
              ? MessageModelDropdown(
                  conversationId: widget.conversationId,
                  messageId: message.id,
                  currentModelId: message.modelId,
                )
              : null,
          // The variant switcher, for a prompt with several answers. Paging activates a sibling —
          // the server makes it the branch the conversation continues from. Disabled at the ends
          // and mid-run.
          variantControl: unit.variants.length > 1
              ? VariantSwitcher(
                  messageId: message.id,
                  current: unit.activeIndex + 1,
                  total: unit.variants.length,
                  onPrev: !running && unit.activeIndex > 0
                      ? () => notifier.activateVariant(
                          unit.variants[unit.activeIndex - 1].id,
                        )
                      : null,
                  onNext:
                      !running && unit.activeIndex < unit.variants.length - 1
                      ? () => notifier.activateVariant(
                          unit.variants[unit.activeIndex + 1].id,
                        )
                      : null,
                )
              : null,
        );
      },
    );
  }

  /// Groups consecutive same-group assistant answers into one unit each — the **active** variant
  /// (the one on `activePath`, else the newest) plus its siblings for the switcher. Everything
  /// else is a single unit.
  List<_DisplayUnit> _groupVariants(
    List<ConversationMessage> messages,
    List<String> activePath,
  ) {
    String groupIdOf(ConversationMessage m) =>
        m.displayGroupId ?? m.regeneratesPiEntryId ?? m.id;
    final units = <_DisplayUnit>[];
    var i = 0;
    while (i < messages.length) {
      final message = messages[i];
      if (message.role != ConversationMessageRole.assistant) {
        units.add(_DisplayUnit.single(message));
        i++;
        continue;
      }
      final groupId = groupIdOf(message);
      final variants = <ConversationMessage>[];
      while (i < messages.length &&
          messages[i].role == ConversationMessageRole.assistant &&
          groupIdOf(messages[i]) == groupId) {
        variants.add(messages[i]);
        i++;
      }
      if (variants.length > 1) {
        var active = variants.indexWhere((v) => activePath.contains(v.id));
        if (active < 0) active = variants.length - 1;
        units.add(
          _DisplayUnit(
            message: variants[active],
            variants: variants,
            activeIndex: active,
          ),
        );
      } else {
        units.add(_DisplayUnit.single(variants.first));
      }
    }
    return units;
  }

  /// Branches a new conversation from [entryId] and **opens it**.
  ///
  /// Opening it is the whole point: a fork you cannot see is indistinguishable from a button that
  /// did nothing. The source conversation is untouched -- that is the server's guarantee, and it
  /// is why this is safe to do without a confirmation.
  Future<void> _fork(
    BuildContext context,
    WidgetRef ref,
    String entryId,
  ) async {
    try {
      final created = await ref
          .read(conversationsRepositoryProvider)
          .fork(widget.conversationId, entryId);
      ref
          .read(conversationsProvider.notifier)
          .addConversation(created.conversation);
      ref.read(selectedConversationIdProvider.notifier).state =
          created.conversation.id;
    } catch (error) {
      if (context.mounted) {
        // The server's own sentence. `conversation_not_branchable` says *why* -- and the client
        // cannot say it better, because it does not know which of the reasons applied.
        showFToast(
          context: context,
          icon: const Icon(FLucideIcons.circleX),
          title: Text('Could not branch: ${_reason(error)}'),
        );
      }
    }
  }

  static String _reason(Object error) =>
      error is NelleApiException ? error.message : '$error';
}

/// One rendered row: a message, plus — for a variant group — all its sibling answers and which is
/// active. Single turns (a user message, a lone answer, a pending streaming reply) have no variants.
class _DisplayUnit {
  const _DisplayUnit({
    required this.message,
    required this.variants,
    required this.activeIndex,
    this.pending = false,
  });

  factory _DisplayUnit.single(
    ConversationMessage message, {
    bool pending = false,
  }) => _DisplayUnit(
    message: message,
    variants: const [],
    activeIndex: 0,
    pending: pending,
  );

  /// The message to render — the active variant for a group.
  final ConversationMessage message;

  /// The group's answers (empty for a single); `length > 1` is what shows a switcher.
  final List<ConversationMessage> variants;

  /// Index of [message] within [variants].
  final int activeIndex;

  /// An optimistic turn (a streaming reply), not a settled snapshot message.
  final bool pending;
}

/// Says that this conversation came from another one, and that the other one is still there.
///
/// A fork's transcript looks like an ordinary chat that happens to begin mid-thought. Without
/// this the user has no way to tell where it came from -- or, more to the point, that the original
/// still exists untouched, which is the entire reason forking is safe to do without a warning.
class _BranchedBanner extends StatelessWidget {
  const _BranchedBanner({required this.kind});

  final ForkKind kind;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: const ValueKey('k-chat-branched'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      color: scheme.surfaceContainerHighest,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(FLucideIcons.gitBranch, size: 12, color: scheme.outline),
          const SizedBox(width: 6),
          Expanded(
            child: Text(switch (kind) {
              ForkKind.fork =>
                'Branched from another chat. The original is unchanged.',
              ForkKind.clone =>
                'A copy of another chat. The original is unchanged.',
              // A `forkKind` a newer server invents must not blank the banner it belongs to.
              _ => 'Branched from another chat.',
            }, style: TextStyle(fontSize: 11, color: scheme.outline)),
          ),
        ],
      ),
    );
  }
}

/// The one line the transcript shows while a model becomes runnable.
///
/// A first load *downloads* the weights — multi-GB blobs, minutes on an ordinary
/// connection — and used to be indistinguishable from a hung load. The server now says
/// which phase it is in and how many bytes have landed; older servers (or routers that
/// report nothing) fall back to the generic "Loading weights…". Public so a test can pin
/// every wording without pumping the whole transcript.
String modelLoadLabel(ModelLoad? load) {
  if (load == null) {
    return 'Loading weights…';
  }
  if (load.downloading) {
    final done = load.downloadedBytes;
    final total = load.totalBytes;
    if (done != null && total != null && total > 0) {
      final fraction = load.progress ?? (done / total);
      final pct = (fraction * 100).clamp(0, 100).toStringAsFixed(0);
      return 'Downloading model… $pct% (${_bytesLabel(done)} / ${_bytesLabel(total)})';
    }
    // Routers that emit no download SSE still yield bytes measured off the disk — but no
    // total, so no percentage: a number the server never sent must not be invented.
    if (done != null && done > 0) {
      return 'Downloading model… ${_bytesLabel(done)}';
    }
    return 'Downloading model…';
  }
  final progress = load.progress;
  final pct = progress == null
      ? null
      : (progress * 100).clamp(0, 100).toStringAsFixed(0);
  return pct == null ? 'Loading weights…' : 'Loading weights $pct%';
}

String _bytesLabel(int bytes) {
  if (bytes >= 1000 * 1000 * 1000) {
    return '${(bytes / (1000 * 1000 * 1000)).toStringAsFixed(1)} GB';
  }
  return '${(bytes / (1000 * 1000)).round()} MB';
}

class _LoadingWeights extends StatelessWidget {
  const _LoadingWeights({this.load});

  final ModelLoad? load;

  @override
  Widget build(BuildContext context) {
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
            Text(modelLoadLabel(load)),
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

/// "Conversation compacted." — a row the server does not send and never will.
class _CompactNote extends StatelessWidget {
  const _CompactNote({required this.note});

  final String note;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      key: const ValueKey('k-chat-compact-note'),
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Center(
        child: Text(
          note,
          style: TextStyle(fontSize: 12, color: scheme.outline),
        ),
      ),
    );
  }
}
