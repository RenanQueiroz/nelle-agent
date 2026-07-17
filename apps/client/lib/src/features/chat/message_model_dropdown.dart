import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../models/model_picker.dart';
import 'chat_controller.dart';

/// The assistant footer's **model dropdown** — the same [ModelPickerSelect] the composer uses,
/// so it behaves identically (searchable, favourites-first, hover-reactive rows, live status).
///
/// Picking a model does **two** things: it repins the conversation's default model (going
/// forward) via `setModel`, then re-answers *this* message with it via `regenerate` — the old
/// answer survives as a labelled variant, which is the server's doing.
///
/// `chat_view` injects this only when regenerating is allowed; on a run in flight or a pending
/// turn `MessageBubble` shows the alias as plain text instead (`modelControl` is null).
class MessageModelDropdown extends ConsumerWidget {
  const MessageModelDropdown({
    super.key,
    required this.conversationId,
    required this.messageId,
    this.currentModelId,
  });

  final String conversationId;
  final String messageId;

  /// The model that generated this message — shown in the trigger and marked as current in the
  /// list. May differ from the conversation's default (an earlier footer pick), which picking any
  /// row reconciles.
  final String? currentModelId;

  @override
  Widget build(BuildContext context, WidgetRef ref) => ModelPickerSelect(
    conversationId: conversationId,
    value: currentModelId,
    // Narrower than the composer's: a footer has stats and actions beside it.
    width: 240,
    triggerKey: ValueKey('k-msg-model-$messageId'),
    keyPrefix: 'k-msg-model',
    onSelected: (id) => _pick(context, ref, id),
  );

  /// Repins the conversation default, then regenerates this message with the chosen model.
  ///
  /// Order matters: `setModel` is the "going forward" half; `regenerate` carries the explicit
  /// override so the re-answer is deterministic regardless of when the PATCH lands. `regenerate`
  /// early-returns if a run is already in flight.
  Future<void> _pick(BuildContext context, WidgetRef ref, String modelId) async {
    final notifier = ref.read(
      chatControllerProvider(conversationId).notifier,
    );
    try {
      await notifier.setModel(modelId);
      await notifier.regenerate(messageId, modelId: modelId);
    } catch (e) {
      if (context.mounted) {
        showFToast(
          context: context,
          icon: const Icon(FLucideIcons.circleX),
          title: Text('Could not switch model: $e'),
        );
      }
    }
  }
}
