import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/reasoning_level.dart';
import 'chat_controller.dart';

/// The composer's reasoning control: how hard the model thinks on **this**
/// conversation (reasoning is per conversation, not global).
///
/// `canReason` is a **tri-state** and is read as one. llama.cpp answers `/props` only
/// for a model it has loaded at least once, so `null` means "not known yet" and the
/// control stays editable — locking it would be guessing. Only `false`, a chat
/// template that provably has no thinking mode, pins it to `off`.
class ReasoningSelector extends ConsumerWidget {
  const ReasoningSelector({super.key, required this.conversationId});

  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chat = ref.watch(chatControllerProvider(conversationId)).valueOrNull;
    if (chat == null) {
      return const SizedBox.shrink();
    }
    // `false` means llama.cpp has loaded this model and its template has no thinking
    // mode. There is nothing to choose, so say so rather than offering five levels
    // that would all behave the same.
    final canReason = chat.canReason;
    if (canReason == false) {
      return const _NoReasoning();
    }

    return SizedBox(
      width: 150,
      child: FSelect<ReasoningLevel>(
        key: const ValueKey('k-composer-reasoning'),
        items: {
          for (final level in ReasoningLevel.$valuesDefined)
            _label(level): level,
        },
        control: FSelectControl.lifted(
          value: chat.reasoningLevel,
          onChange: (level) =>
              level == null ? null : _pick(context, ref, level),
        ),
        hint: 'Thinking',
        prefixBuilder: (context, style, variants) => Padding(
          padding: const EdgeInsetsDirectional.only(start: 10),
          child: Icon(
            FLucideIcons.brain,
            size: 15,
            color: context.theme.colors.mutedForeground,
          ),
        ),
      ),
    );
  }

  /// `off` is a state, not a level, so it is named as one.
  String _label(ReasoningLevel level) => switch (level) {
    ReasoningLevel.off => 'No thinking',
    ReasoningLevel.low => 'Think: low',
    ReasoningLevel.medium => 'Think: medium',
    ReasoningLevel.high => 'Think: high',
    ReasoningLevel.max => 'Think: max',
    // Unreachable from the UI ($valuesDefined excludes it), but a snapshot from a
    // newer server can carry a level this build has no name for.
    ReasoningLevel.$unknown => 'Unknown',
  };

  Future<void> _pick(
    BuildContext context,
    WidgetRef ref,
    ReasoningLevel level,
  ) async {
    try {
      await ref
          .read(chatControllerProvider(conversationId).notifier)
          .setReasoningLevel(level);
    } catch (e) {
      if (context.mounted) {
        showFToast(
          context: context,
          icon: const Icon(FLucideIcons.circleX),
          title: Text('Could not change thinking: $e'),
        );
      }
    }
  }
}

/// Shown when llama.cpp has proven the model's template cannot think.
class _NoReasoning extends StatelessWidget {
  const _NoReasoning();

  @override
  Widget build(BuildContext context) => const Padding(
    key: ValueKey('k-composer-reasoning-unsupported'),
    padding: EdgeInsets.symmetric(horizontal: 8),
    child: Text('No thinking'),
  );
}
