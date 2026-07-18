import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/llama_router_model.dart';
import '../../api/generated/models/model_list_item.dart';
import '../chat/chat_controller.dart';
import 'favorites.dart';
import 'router_models_notifier.dart';

/// The searchable model dropdown, shared by the composer's `ModelSelector` and the message
/// footer's `MessageModelDropdown` so they are **the same component** — same `FSelect` trigger,
/// same favourites-first search, same hover-reactive rows, same status lines and favourite stars.
/// Only the width, the current value, and what a pick *does* differ.
class ModelPickerSelect extends ConsumerWidget {
  const ModelPickerSelect({
    super.key,
    required this.conversationId,
    required this.value,
    required this.onSelected,
    required this.triggerKey,
    required this.keyPrefix,
    this.width = 320,
    this.hint = 'Model',
  });

  final String conversationId;

  /// The id shown in the trigger — the conversation's model for the composer, the message's
  /// model for a footer. Externally controlled (`lifted`), so a pick does not move it.
  final String? value;

  /// What a pick does: pin the conversation (composer), or pin + regenerate (footer).
  final void Function(String modelId) onSelected;

  final Key triggerKey;

  /// Namespaces the item and favourite-star keys, so a composer selector and one or more footer
  /// dropdowns can be on screen at once without colliding.
  final String keyPrefix;

  final double width;
  final String hint;

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
    // Stored server-side, so they follow the user to their phone.
    final favorites =
        ref.watch(favoriteModelsProvider).valueOrNull ?? const <String>[];

    return SizedBox(
      width: width,
      child: FSelect<String>.searchBuilder(
        key: triggerKey,
        // The trigger is narrow, so it shows the name alone; status lives in the rows.
        format: (id) => modelDisplayName(catalog, id),
        // Favourites first. The point of a favourite is to be near the top of a list that
        // may hold dozens of models, so the sort *is* the feature.
        filter: (query) =>
            sortByFavorite(filterModels(catalog, query), favorites),
        contentBuilder: (context, query, ids) => [
          for (final id in ids)
            FSelectItem<String>.item(
              key: ValueKey('$keyPrefix-item-$id'),
              value: id,
              title: Text(
                modelDisplayName(catalog, id),
                overflow: TextOverflow.ellipsis,
              ),
              // The status is its own line: as a suffix it was the first thing the
              // ellipsis ate, which hid the very thing the router SSE is here to say.
              subtitle: ModelStatusLine(status: routerModelFor(router, id)),
              // A star, not a menu: favouriting is a one-tap thing you do while you are
              // already looking at the list.
              suffixBuilder: (context, selected) => ModelFavoriteStar(
                modelId: id,
                isFavorite: favorites.contains(id),
                keyPrefix: '$keyPrefix-favorite',
              ),
            ),
        ],
        control: FSelectControl.lifted(
          value: value,
          onChange: (id) {
            if (id != null) onSelected(id);
          },
        ),
        hint: hint,
        prefixBuilder: (context, style, variants) => Padding(
          padding: const EdgeInsetsDirectional.only(start: 10),
          child: Icon(
            FLucideIcons.box,
            size: 15,
            color: context.theme.colors.mutedForeground,
          ),
        ),
      ),
    );
  }
}

/// Shared model-picker helpers, used by **both** the composer's `ModelSelector` and the
/// message footer's model dropdown, so the two render identical rows (name, live router
/// status, favourite star) and cannot drift.

/// The ids of catalog models matching [query] (by id or alias). An empty query is every model.
Iterable<String> filterModels(List<ModelListItem> catalog, String query) {
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

/// The catalog entry for [id], or null when it is not a configured model.
ModelListItem? modelItemFor(List<ModelListItem> catalog, String id) {
  for (final m in catalog) {
    if (m.id == id) {
      return m;
    }
  }
  return null;
}

/// The name to show for [id] — its configured alias, falling back to the id itself.
String modelDisplayName(List<ModelListItem> catalog, String id) {
  final item = modelItemFor(catalog, id);
  return item != null && item.alias.isNotEmpty ? item.alias : id;
}

/// The live router row for a model, matched across the several ids one model answers to
/// (section id, runtime id, alias).
LlamaRouterModel? routerModelFor(
  List<LlamaRouterModel> router,
  String modelId,
) {
  for (final m in router) {
    if (m.sectionId == modelId ||
        m.routerModelId == modelId ||
        m.aliases.contains(modelId)) {
      return m;
    }
  }
  return null;
}

/// The live router status for one row: loaded / sleeping / loading NN% / not loaded.
///
/// Renders nothing when llama.cpp has never mentioned the model, because "unknown" is
/// not "unloaded" — the server loads it when the run starts either way.
class ModelStatusLine extends StatelessWidget {
  const ModelStatusLine({super.key, required this.status});

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

/// Toggles a favourite without selecting the model.
///
/// It sits inside a select/menu row, so the tap must not fall through to the row and switch
/// the model — picking a model and starring one are different intentions, and a user who meant
/// to star would be very surprised. [keyPrefix] namespaces the `ValueKey` so the composer
/// selector and the footer dropdown can both be on screen without colliding.
class ModelFavoriteStar extends ConsumerWidget {
  const ModelFavoriteStar({
    super.key,
    required this.modelId,
    required this.isFavorite,
    this.keyPrefix = 'k-model-favorite',
  });

  final String modelId;
  final bool isFavorite;
  final String keyPrefix;

  @override
  // A ghost FButton.icon, not a Material IconButton: forui over a bare FScaffold has no Material
  // ancestor for an ink splash.
  Widget build(BuildContext context, WidgetRef ref) => FButton.icon(
    key: ValueKey('$keyPrefix-$modelId'),
    size: FButtonSizeVariant.xs,
    variant: FButtonVariant.ghost,
    onPress: () => ref.read(favoriteModelsProvider.notifier).toggle(modelId),
    // Lucide is an outline set with no filled star, so the state is carried by colour:
    // the favourite is the accent, the rest are barely there. One icon, two colours.
    child: Icon(
      FLucideIcons.star,
      size: 14,
      color: isFavorite
          ? Theme.of(context).colorScheme.primary
          : Theme.of(context).colorScheme.outline.withValues(alpha: 0.4),
    ),
  );
}

/// Local `unawaited` so a fire-and-forget model warm reads as deliberate, swallowing its error
/// (the real failure surfaces on the run, which waits for the load anyway).
void unawaitedWarm(Future<void> future) {
  future.catchError((Object _) {});
}
