import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/llama_router_model.dart';
import '../chat/chat_controller.dart';
import 'llama_repository.dart';
import 'model_picker.dart';
import 'router_models_notifier.dart';

/// The composer's model picker.
///
/// A thin wrapper over the shared [ModelPickerSelect] — the same component the message-footer
/// dropdown uses — that pins the picked model to the conversation (`PATCH
/// /api/conversations/:id`) and warms its weights, fire-and-forget: the run waits on its own, so
/// a load must never block the send.
class ModelSelector extends ConsumerWidget {
  const ModelSelector({super.key, required this.conversationId});

  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chat = ref.watch(chatControllerProvider(conversationId)).valueOrNull;
    if (chat == null) {
      return const SizedBox.shrink();
    }
    return ModelPickerSelect(
      conversationId: conversationId,
      value: chat.modelId,
      triggerKey: const ValueKey('k-composer-model'),
      keyPrefix: 'k-composer-model',
      onSelected: (id) => _pick(context, ref, id),
    );
  }

  Future<void> _pick(BuildContext context, WidgetRef ref, String modelId) async {
    try {
      await ref
          .read(chatControllerProvider(conversationId).notifier)
          .setModel(modelId);
    } catch (e) {
      if (context.mounted) {
        showFToast(
          context: context,
          icon: const Icon(FLucideIcons.circleX),
          title: Text('Could not switch model: $e'),
        );
      }
      return;
    }

    // Warm the weights while the user types. Deliberately not awaited and its failure
    // is swallowed: the send surfaces a real model_load_failed, and the run waits for
    // the load anyway.
    final router =
        ref.read(routerModelsProvider).valueOrNull ??
        const <LlamaRouterModel>[];
    final live = routerModelFor(router, modelId);
    if (live != null && !isRunnableRouterStatus(live.status)) {
      unawaitedWarm(ref.read(llamaRepositoryProvider).load(modelId));
    }
  }
}
