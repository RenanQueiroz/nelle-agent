import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/configured_model.dart';
import 'global_params_screen.dart';
import 'huggingface_screen.dart';
import 'active_runs.dart';
import 'model_detail_screen.dart';
import 'models_controller.dart';
import 'router_models_notifier.dart';

/// Settings > This server > **Models**: the `models.ini` catalog.
///
/// A list that opens a detail screen, deliberately — `apps/web` crams the alias field, the
/// param editor and six buttons into every row, which is unusable on a phone and is how its
/// shared `'activate'` busy key came to spin every row's button at once.
class ModelsScreen extends ConsumerStatefulWidget {
  const ModelsScreen({super.key});

  @override
  ConsumerState<ModelsScreen> createState() => _ModelsScreenState();
}

class _ModelsScreenState extends ConsumerState<ModelsScreen> {
  /// What the detail screen said on its way out — a reclaim, or a reclaim that did *not* happen
  /// because a sibling model still holds the weights. It cannot be shown on the detail screen:
  /// the model is gone, and so is the screen.
  String? _notice;

  @override
  Widget build(BuildContext context) {
    final catalog = ref.watch(modelCatalogProvider);
    final theme = Theme.of(context);

    return FScaffold(
      header: FHeader.nested(
        title: const Text('Models'),
        prefixes: [
          FHeaderAction.back(
            key: const ValueKey('k-models-back'),
            onPress: Navigator.of(context).pop,
          ),
        ],
        suffixes: [
          FHeaderAction(
            key: const ValueKey('k-models-add'),
            icon: const Icon(FLucideIcons.plus),
            onPress: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => const HuggingFaceScreen(),
              ),
            ),
          ),
        ],
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: switch (catalog) {
            AsyncData(:final value) => ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
              children: [
                if (_notice != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: Text(
                      _notice!,
                      key: const ValueKey('k-models-notice'),
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                if (value.models.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      'No models yet. Search Hugging Face to add one.',
                      key: const ValueKey('k-models-empty'),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
                for (final model in value.models)
                  _ModelTile(
                    key: ValueKey('k-model-tile-${model.id}'),
                    model: model,
                    isActive: model.id == value.activeModelId,
                    onResult: (message) => setState(() => _notice = message),
                  ),
                const SizedBox(height: 20),
                FTile(
                  key: const ValueKey('k-models-global-params'),
                  onPress: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => const GlobalParamsScreen(),
                    ),
                  ),
                  title: const Text('Global parameters'),
                  subtitle: const Text(
                    'The [*] section. Applied to every model; a model’s own params win.',
                  ),
                  suffix: const Icon(FLucideIcons.chevronRight, size: 16),
                ),
              ],
            ),
            AsyncError(:final error) => Padding(
              padding: const EdgeInsets.all(24),
              child: Text(
                '$error',
                key: const ValueKey('k-models-error'),
                textAlign: TextAlign.center,
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ),
    );
  }
}

class _ModelTile extends ConsumerWidget {
  const _ModelTile({
    super.key,
    required this.model,
    required this.isActive,
    required this.onResult,
  });

  final ConfiguredModel model;
  final bool isActive;
  final ValueChanged<String?> onResult;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final routerAsync = ref.watch(routerModelsProvider);
    final routerModels = routerAsync.valueOrNull;
    // Match by section id and nothing else. `apps/web` used to try four more conditions and
    // deleted them: it was a reimplementation of work the server already does, and a rule a
    // second client would have had to copy.
    final router = routerModels
        ?.where((item) => item.sectionId == model.id)
        .firstOrNull;
    // A model mid-answer, so the row says so before the user opens it and finds three dead
    // buttons. It goes *first* in the subtitle: it is the reason the model cannot be touched,
    // and the line is ellipsized.
    final busy = ref.watch(activeRunModelIdsProvider).contains(model.id);

    return FTile(
      onPress: () async {
        final message = await Navigator.of(context).push<String>(
          MaterialPageRoute<String>(
            builder: (_) => ModelDetailScreen(modelId: model.id),
          ),
        );
        if (message != null) onResult(message);
      },
      title: Text(model.name, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Text(
        [
          if (busy) 'answering',
          routerStatusLabel(router, listed: routerModels),
          if (model.diskBytes != null) formatBytes(model.diskBytes),
          if (isActive) 'default for new chats',
        ].join(' · '),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
      ),
      suffix: const Icon(FLucideIcons.chevronRight, size: 16),
    );
  }

}
