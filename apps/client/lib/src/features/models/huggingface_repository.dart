import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/generated/models/configured_model.dart';
import '../../api/generated/models/hugging_face_model_result.dart';
import '../../api/generated/models/hugging_face_search_response.dart';
import '../../api/request.dart';

/// Browsing Hugging Face for a GGUF to import.
class HuggingFaceRepository {
  HuggingFaceRepository(this._dio);

  final Dio _dio;

  /// The server walks eight repositories over the network, so this takes **seconds**, not
  /// milliseconds — say so in the UI, and give it a timeout that respects it.
  ///
  /// Every quant it returns is one llama.cpp would actually resolve: `mmproj`, `imatrix` and
  /// `mtp-` files are its *accessories* (downloaded alongside the chosen model), and offering
  /// one as a quant offers the accessory instead of the thing. That filtering is the
  /// server's — the client renders what it is given.
  Future<List<HuggingFaceModelResult>> search(String query) async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>(
        '/api/huggingface/search',
        queryParameters: {'q': query},
        options: longCall(),
      ),
    );
    return HuggingFaceSearchResponse.fromJson(res.data ?? const {}).results;
  }

  /// Imports a model. **Never hand-roll the section id**: `hf-repo` keeps the *exact* ref
  /// (`…:UD-Q4_K_XL`) while the id uses llama.cpp's canonical tag (`…:Q4_K_XL`), and only the
  /// server knows how to derive one from the other.
  ///
  /// This writes a `models.ini` section and returns at once — it does **not** download
  /// anything. The weights arrive on the model's first load, which is why that load takes
  /// minutes and streams `download_progress` on the router SSE.
  Future<ConfiguredModel> use({
    required String repoId,
    required String quant,
    String? name,
  }) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/huggingface/use',
        data: {'repoId': repoId, 'quant': quant, 'name': ?name},
        options: longCall(),
      ),
    );
    return ConfiguredModel.fromJson(
      (res.data?['model'] as Map?)?.cast<String, Object?>() ?? const {},
    );
  }
}

final huggingFaceRepositoryProvider = Provider<HuggingFaceRepository>(
  (ref) => HuggingFaceRepository(ref.watch(dioProvider)),
);
