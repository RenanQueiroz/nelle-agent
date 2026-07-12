import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/llama_router_model.dart';
import '../../api/generated/models/model_list_item.dart';
import '../chat/chat_controller.dart';
import 'llama_repository.dart';
import 'router_models_notifier.dart';

/// The composer's model picker.
///
/// Items come from the snapshot's configured catalog (`models.available`), which is
/// present even when llama.cpp is stopped — you must still be able to pick a model,
/// because the server loads the conversation's model when the run starts.
/// Status/progress is overlaid from llama.cpp's live router SSE when it is up.
///
/// Picking **pins the conversation** (`PATCH /api/conversations/:id`); it does not
/// activate a global model. It also warms the weights, fire-and-forget: the run waits
/// on its own, so a load must never block the send.
class ModelSelector extends ConsumerWidget {
  const ModelSelector({super.key, required this.conversationId});

  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final chat = ref.watch(chatControllerProvider(conversationId)).valueOrNull;
    if (chat == null) {
      return const SizedBox.shrink();
    }
    final catalog = chat.snapshot.models.available;
    if (catalog.isEmpty) {
      return const SizedBox.shrink();
    }
    // llama.cpp may be down; then there is simply no live status to overlay.
    final router =
        ref.watch(routerModelsProvider).valueOrNull ??
        const <LlamaRouterModel>[];

    return SizedBox(
      width: 320,
      child: FSelect<String>.searchBuilder(
        key: const ValueKey('k-composer-model'),
        // The trigger is narrow, so it shows the name alone; status lives in the rows.
        format: (id) => _name(_itemFor(catalog, id) ?? id, id),
        filter: (query) => _filter(catalog, query),
        contentBuilder: (context, query, ids) => [
          for (final id in ids)
            FSelectItem<String>.item(
              key: ValueKey('k-composer-model-item-$id'),
              value: id,
              title: Text(
                _name(_itemFor(catalog, id) ?? id, id),
                overflow: TextOverflow.ellipsis,
              ),
              // The status is its own line: as a suffix it was the first thing the
              // ellipsis ate, which hid the very thing the router SSE is here to say.
              subtitle: _StatusLine(status: _routerFor(router, id)),
            ),
        ],
        control: FSelectControl.lifted(
          value: chat.modelId,
          onChange: (id) => id == null ? null : _pick(context, ref, id, router),
        ),
        hint: 'Model',
      ),
    );
  }

  Iterable<String> _filter(List<ModelListItem> catalog, String query) {
    final q = query.trim().toLowerCase();
    return catalog
        .where(
          (m) =>
              q.isEmpty ||
              m.id.toLowerCase().contains(q) ||
              m.alias.toLowerCase().contains(q),
        )
        .map((m) => m.id);
  }

  ModelListItem? _itemFor(List<ModelListItem> catalog, String id) {
    for (final m in catalog) {
      if (m.id == id) {
        return m;
      }
    }
    return null;
  }

  String _name(Object model, String id) =>
      model is ModelListItem && model.alias.isNotEmpty ? model.alias : id;

  LlamaRouterModel? _routerFor(List<LlamaRouterModel> router, String modelId) {
    for (final m in router) {
      if (m.sectionId == modelId ||
          m.routerModelId == modelId ||
          m.aliases.contains(modelId)) {
        return m;
      }
    }
    return null;
  }

  Future<void> _pick(
    BuildContext context,
    WidgetRef ref,
    String modelId,
    List<LlamaRouterModel> router,
  ) async {
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
    final live = _routerFor(router, modelId);
    if (live != null && !isRunnableRouterStatus(live.status)) {
      unawaited(ref.read(llamaRepositoryProvider).load(modelId));
    }
  }
}

/// The live router status for one row: loaded / sleeping / loading NN% / not loaded.
///
/// Renders nothing when llama.cpp has never mentioned the model, because "unknown" is
/// not "unloaded" — the server loads it when the run starts either way.
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.status});

  final LlamaRouterModel? status;

  @override
  Widget build(BuildContext context) {
    final router = status;
    if (router == null) {
      return const SizedBox.shrink();
    }
    return Text(_text(router), overflow: TextOverflow.ellipsis);
  }

  String _text(LlamaRouterModel router) {
    if (router.status.toLowerCase() == 'loading') {
      final progress = router.progress;
      return progress == null
          ? 'loading…'
          : 'loading ${(progress * 100).clamp(0, 100).toStringAsFixed(0)}%';
    }
    return isRunnableRouterStatus(router.status) ? router.status : 'not loaded';
  }
}

/// Local `unawaited` so the fire-and-forget load reads as deliberate.
void unawaited(Future<void> future) {
  future.catchError((Object _) {});
}
