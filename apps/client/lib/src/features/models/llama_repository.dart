import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/generated/models/llama_models_response.dart';
import '../../api/generated/models/llama_router_model.dart';
import '../../api/request.dart';

/// llama.cpp's router: the live model list plus load/unload.
///
/// Note the client never *has* to load a model: the server's
/// `ensureModelReadyForRun()` loads the conversation's model on send and the run
/// waits. Loading here is only so the weights warm while the user is still typing.
class LlamaRepository {
  LlamaRepository(this._dio);

  final Dio _dio;

  Future<List<LlamaRouterModel>> list({CancelToken? cancelToken}) async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>(
        '/api/llama/models',
        cancelToken: cancelToken,
      ),
    );
    return LlamaModelsResponse.fromJson(res.data ?? const {}).models;
  }

  /// Fire-and-forget from the caller's point of view: a failure here is not fatal,
  /// because the send would surface a real `model_load_failed`.
  Future<void> load(String modelId) async {
    await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/llama/models/${Uri.encodeComponent(modelId)}/load',
      ),
    );
  }

  Future<void> unload(String modelId) async {
    await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/llama/models/${Uri.encodeComponent(modelId)}/unload',
      ),
    );
  }

  /// Re-reads `models.ini`. The router's model list is a **startup snapshot**: delete a
  /// model's weights and it keeps offering it until this is called.
  Future<void> reload() async {
    await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/llama/models/reload',
        options: longCall(),
      ),
    );
  }
}

final llamaRepositoryProvider = Provider<LlamaRepository>(
  (ref) => LlamaRepository(ref.watch(dioProvider)),
);
