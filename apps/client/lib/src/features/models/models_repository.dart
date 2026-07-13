import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/configured_model.dart';
import '../../api/generated/models/invalid_model_param.dart';
import '../../api/generated/models/delete_model_response.dart';
import '../../api/generated/models/model_catalog.dart';
import '../../api/generated/models/model_param_warning.dart';
import '../../api/request.dart';

/// A refused params save, with **every** offending key — not just the first.
///
/// A form with three typos should light up three rows on one save, not on three. Join these
/// to rows **by `key`**, never by row id: a row must stop being marked the moment its key
/// changes, and editing one row must not unmark another.
class InvalidModelParamsException extends NelleApiException {
  InvalidModelParamsException(
    super.message, {
    required this.invalidParams,
    super.code,
    super.statusCode,
  });

  final List<InvalidModelParam> invalidParams;
}

/// The `models.ini` catalog.
///
/// **Every mutation answers with the whole catalog, and the caller applies it.** It has to:
/// activate, duplicate and delete all move `activeModelId` — a duplicate *becomes* the active
/// model, and deleting the active one promotes a neighbour — and editing `[*]` rewrites the
/// derived `contextSize` of every model at once. Patching the one row you touched and
/// guessing at the rest shows stale numbers everywhere else.
class ModelsRepository {
  ModelsRepository(this._dio);

  final Dio _dio;

  Future<ModelCatalog> catalog() async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>('/api/models'),
    );
    return ModelCatalog.fromJson(res.data ?? const {});
  }

  /// Edits a model.
  ///
  /// **[params] is flat, and it replaces `extra` wholesale.** The read shape
  /// (`ConfiguredModel.params`) is *not* the write shape: it carries a read-only
  /// `contextSize` derived from the `[*]`-plus-section cascade, and sending it back is a 400.
  /// Edit `params.extra`; send it flat.
  ///
  /// [pinned] `false` lets the next load re-check Hugging Face, so an upstream fix can land.
  /// It re-pins itself once that load succeeds — an update is a deliberate act.
  ///
  /// Answers the catalog **and any warnings**. A warning is not an error: a context past the
  /// model's trained window is what RoPE/YaRN extension *is*, so the value saves and the user
  /// is told what they just asked for. Dropping warnings on the floor means the user finds out
  /// by crashing the machine — which is precisely how this warning came to exist.
  Future<ModelUpdate> update(
    String id, {
    String? name,
    bool? pinned,
    Map<String, String>? params,
  }) async {
    final res = await _mutateRaw(
      () => _dio.patch<Map<String, dynamic>>(
        '/api/models/${Uri.encodeComponent(id)}',
        // Only what the caller touched: a save must not rewrite a field they never looked at.
        data: {'name': ?name, 'pinned': ?pinned, 'params': ?params},
        options: longCall(),
      ),
    );
    final warnings = res.data?['warnings'];
    return ModelUpdate(
      catalog: _catalogOf(res),
      warnings: warnings is List
          ? warnings
                .map(
                  (e) => ModelParamWarning.fromJson(
                    (e as Map).cast<String, Object?>(),
                  ),
                )
                .toList()
          : const [],
    );
  }

  /// The `[*]` section: applied to every model, overridden by a model's own params. A full
  /// replacement, which is what makes a global context cap *removable* — an empty map clears
  /// the section.
  Future<ModelCatalog> updateGlobalParams(Map<String, String> params) {
    return _mutate(
      () => _dio.patch<Map<String, dynamic>>(
        '/api/models/global-params',
        data: {'params': params},
        options: longCall(),
      ),
    );
  }

  /// The **global default new conversations inherit** — not what any open chat runs on.
  Future<ModelCatalog> activate(String id) {
    return _mutate(
      () => _dio.post<Map<String, dynamic>>(
        '/api/models/${Uri.encodeComponent(id)}/activate',
        options: longCall(),
      ),
    );
  }

  Future<ModelCatalog> duplicate(String id) {
    return _mutate(
      () => _dio.post<Map<String, dynamic>>(
        '/api/models/${Uri.encodeComponent(id)}/duplicate',
        options: longCall(),
      ),
    );
  }

  /// Removes a model's `models.ini` section, and — with [withWeights] — its weights too.
  ///
  /// Deleting a model has always left the weights on disk for ever, invisibly: that is how a
  /// 6.7 GB model nobody had configured came to be sitting in the cache. Reclaiming them is
  /// only safe because the cache is Nelle's now.
  ///
  /// **The server may refuse to delete the weights anyway**, and say so: a Hugging Face repo
  /// directory holds *every* quant of that repo, so two models on one repository share one
  /// pile of blobs. `sharedWithModelIds` names the models that kept them alive — render it,
  /// because otherwise the reclaim silently does nothing.
  Future<DeleteModelResponse> remove(
    String id, {
    bool withWeights = false,
  }) async {
    final res = await sendJson(
      () => _dio.delete<Map<String, dynamic>>(
        '/api/models/${Uri.encodeComponent(id)}'
        '${withWeights ? '?weights=1' : ''}',
        options: longCall(),
      ),
    );
    return DeleteModelResponse.fromJson(res.data ?? const {});
  }

  /// Every mutation returns `{..., catalog}` and a 400 carries `invalidParams`.
  Future<ModelCatalog> _mutate(
    Future<Response<Map<String, dynamic>>> Function() run,
  ) async => _catalogOf(await _mutateRaw(run));

  ModelCatalog _catalogOf(Response<Map<String, dynamic>> res) =>
      ModelCatalog.fromJson(
        (res.data?['catalog'] as Map?)?.cast<String, Object?>() ?? const {},
      );

  /// The shared 400 handling. Kept separate from [_mutate] so `update` can read the
  /// `warnings` the body may also carry without re-implementing any of this.
  Future<Response<Map<String, dynamic>>> _mutateRaw(
    Future<Response<Map<String, dynamic>>> Function() run,
  ) async {
    final Response<Map<String, dynamic>> res;
    try {
      res = await run();
    } on DioException catch (e) {
      throw NelleApiException.network(e);
    }

    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      // The server names every bad key. Surfacing one line of red text instead would tell
      // the user nothing they can act on.
      final invalid = res.data?['invalidParams'];
      if (invalid is List && invalid.isNotEmpty) {
        final error = res.data?['error'];
        throw InvalidModelParamsException(
          error is Map
              ? (error['message'] as String? ?? 'Invalid parameters.')
              : 'Invalid parameters.',
          code: error is Map ? error['code'] as String? : null,
          statusCode: code,
          invalidParams: invalid
              .map(
                (e) => InvalidModelParam.fromJson(
                  (e as Map).cast<String, Object?>(),
                ),
              )
              .toList(),
        );
      }
      throw NelleApiException.fromResponse(res);
    }
    return res;
  }
}

/// What a model save answered with. The warnings are things the save **did**, not reasons it
/// failed — a refusal throws.
class ModelUpdate {
  const ModelUpdate({required this.catalog, required this.warnings});

  final ModelCatalog catalog;
  final List<ModelParamWarning> warnings;
}

/// Convenience: the model a catalog says is the global default, or `null`.
ConfiguredModel? activeModel(ModelCatalog catalog) {
  for (final model in catalog.models) {
    if (model.id == catalog.activeModelId) return model;
  }
  return null;
}

final modelsRepositoryProvider = Provider<ModelsRepository>(
  (ref) => ModelsRepository(ref.watch(dioProvider)),
);
