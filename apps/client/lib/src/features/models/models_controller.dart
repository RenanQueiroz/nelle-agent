import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/configured_model.dart';
import '../../api/generated/models/delete_model_response.dart';
import '../../api/generated/models/model_catalog.dart';
import '../../api/generated/models/model_param_warning.dart';
import 'models_repository.dart';

/// The `models.ini` catalog.
///
/// **Every mutation answers with the whole catalog, and this applies it.** It has to: activate,
/// duplicate and delete all move `activeModelId` — a duplicate *becomes* the active model, and
/// deleting the active one promotes a neighbour — and editing `[*]` rewrites the derived
/// `contextSize` of every model at once.
final modelCatalogProvider =
    AsyncNotifierProvider<ModelCatalogNotifier, ModelCatalog>(
      ModelCatalogNotifier.new,
    );

class ModelCatalogNotifier extends AsyncNotifier<ModelCatalog> {
  @override
  Future<ModelCatalog> build() => ref.watch(modelsRepositoryProvider).catalog();

  Future<void> refresh() async {
    state = await AsyncValue.guard(
      () => ref.read(modelsRepositoryProvider).catalog(),
    );
  }

  Future<void> activate(String id) => _apply((repo) => repo.activate(id));

  Future<void> duplicate(String id) => _apply((repo) => repo.duplicate(id));

  Future<void> rename(String id, String name) =>
      _update(id, (repo) => repo.update(id, name: name));

  /// `pinned: false` lets the next load re-check Hugging Face, so an upstream fix can land. It
  /// re-pins itself once that load succeeds — an update is a deliberate act, not a standing
  /// exposure.
  Future<void> setPinned(String id, bool pinned) =>
      _update(id, (repo) => repo.update(id, pinned: pinned));

  /// Returns the warnings the save produced — a context past the model's trained window is
  /// legitimate (RoPE/YaRN) so it *saves*, and the caller must say what just happened.
  Future<List<ModelParamWarning>> saveParams(
    String id,
    Map<String, String> params,
  ) async {
    final update = await ref
        .read(modelsRepositoryProvider)
        .update(id, params: params);
    state = AsyncValue.data(update.catalog);
    return update.warnings;
  }

  Future<void> _update(
    String id,
    Future<ModelUpdate> Function(ModelsRepository) run,
  ) async {
    final update = await run(ref.read(modelsRepositoryProvider));
    state = AsyncValue.data(update.catalog);
  }

  Future<void> saveGlobalParams(Map<String, String> params) =>
      _apply((repo) => repo.updateGlobalParams(params));

  /// Returns the server's answer, because it may have **kept** the weights: a repository is
  /// shared by every quant of it, so a sibling model can be holding them alive. The caller
  /// must say so rather than claim a reclaim that did not happen.
  Future<DeleteModelResponse> remove(
    String id, {
    bool withWeights = false,
  }) async {
    final response = await ref
        .read(modelsRepositoryProvider)
        .remove(id, withWeights: withWeights);
    state = AsyncValue.data(response.catalog);
    return response;
  }

  /// Applies the catalog the server answers with — and **rethrows** on failure.
  ///
  /// `AsyncValue.guard` would be the idiomatic call here, and it is wrong: it *captures* the
  /// exception into `state`, so the caller never sees it. A refused params save would then
  /// silently do nothing — no marked rows, no message, just a save that quietly did not happen.
  /// (It did exactly that until a typo was typed into the running app.) A failed mutation also
  /// leaves the catalog alone: it is still perfectly valid, and blanking the screen because one
  /// key was misspelled would be absurd.
  Future<void> _apply(
    Future<ModelCatalog> Function(ModelsRepository) run,
  ) async {
    final catalog = await run(ref.read(modelsRepositoryProvider));
    state = AsyncValue.data(catalog);
  }
}

/// One model out of the catalog, or `null` once it has been deleted.
ConfiguredModel? modelById(ModelCatalog? catalog, String id) {
  if (catalog == null) return null;
  for (final model in catalog.models) {
    if (model.id == id) return model;
  }
  return null;
}

/// `14.2 GB`. `null` is not zero: it means nothing has been downloaded yet — the weights arrive
/// on the model's first load — or that the cache is the user's, not Nelle's.
String formatBytes(num? bytes) {
  if (bytes == null) return 'Not downloaded';
  var value = bytes.toDouble();
  for (final unit in const ['B', 'KB', 'MB', 'GB', 'TB']) {
    if (value < 1024) {
      return '${value.toStringAsFixed(unit == 'B' ? 0 : 1)} $unit';
    }
    value /= 1024;
  }
  return '${value.toStringAsFixed(1)} PB';
}
