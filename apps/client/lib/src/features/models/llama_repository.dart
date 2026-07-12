import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/llama_models_response.dart';
import '../../api/generated/models/llama_router_model.dart';

/// llama.cpp's router: the live model list plus load/unload.
///
/// Note the client never *has* to load a model: the server's
/// `ensureModelReadyForRun()` loads the conversation's model on send and the run
/// waits. Loading here is only so the weights warm while the user is still typing.
class LlamaRepository {
  LlamaRepository(this._dio);

  final Dio _dio;

  Future<List<LlamaRouterModel>> list() async {
    final res = await _send(
      () => _dio.get<Map<String, dynamic>>('/api/llama/models'),
    );
    return LlamaModelsResponse.fromJson(res.data ?? const {}).models;
  }

  /// Fire-and-forget from the caller's point of view: a failure here is not fatal,
  /// because the send would surface a real `model_load_failed`.
  Future<void> load(String modelId) async {
    await _send(
      () => _dio.post<Map<String, dynamic>>(
        '/api/llama/models/${Uri.encodeComponent(modelId)}/load',
      ),
    );
  }

  Future<void> unload(String modelId) async {
    await _send(
      () => _dio.post<Map<String, dynamic>>(
        '/api/llama/models/${Uri.encodeComponent(modelId)}/unload',
      ),
    );
  }

  Future<Response<Map<String, dynamic>>> _send(
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
      // llama.cpp stopped answers 502 here; that is a state, not a crash.
      throw NelleApiException.fromResponse(res);
    }
    return res;
  }
}

final llamaRepositoryProvider = Provider<LlamaRepository>(
  (ref) => LlamaRepository(ref.watch(dioProvider)),
);
