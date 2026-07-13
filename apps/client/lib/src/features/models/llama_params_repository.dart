import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/generated/models/llama_option.dart';
import '../../api/generated/models/llama_option_catalogue.dart';
import '../../api/request.dart';

/// llama.cpp's option catalogue: what a `models.ini` key is validated against.
///
/// **The client must never validate against it.** Keys are checked against the *binary* —
/// `llama-server --help`, parsed by the server — and an unknown key is fatal (llama-server
/// refuses to start with `option '...' not recognized in preset`). A second copy of that rule
/// living in the client is exactly how it goes stale on the next llama.cpp upgrade. Ship the
/// keys, render the server's refusal.
///
/// It is here for **completion and hints** only, and `available: false` (no binary, or a
/// `--help` the server could not parse) means the unknown-key check is *skipped* server-side:
/// refusing to save a parameter because Nelle could not run a binary is worse than the typo.
class LlamaParamsRepository {
  LlamaParamsRepository(this._dio);

  final Dio _dio;

  Future<LlamaOptionCatalogue> catalogue() async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>('/api/llama/params'),
    );
    return LlamaOptionCatalogue.fromJson(res.data ?? const {});
  }
}

/// Fetched **once** and kept.
///
/// It is 244 options and ~47 kB, and it only changes when llama.cpp is upgraded — so
/// re-fetching it per keystroke, on a phone, over a LAN, would be absurd. A `Provider` caches
/// for the app's life; invalidate it after an install, which is the one thing that can move
/// it.
final llamaOptionCatalogueProvider = FutureProvider<LlamaOptionCatalogue>(
  (ref) => ref.watch(llamaParamsRepositoryProvider).catalogue(),
);

/// Every key llama-server accepts, for completion. Empty when the catalogue is unavailable,
/// which is a real state and not an error: the server skips the unknown-key check too.
Set<String> acceptedParamKeys(LlamaOptionCatalogue catalogue) {
  if (!catalogue.available) return const {};
  return {
    for (final LlamaOption option in catalogue.options) ...option.keys,
    // Env-var spellings are keys too: `common/preset.cpp` builds the same union, which is why
    // a validator that only knew `ctx-size` would reject Nelle's own `models.ini`.
    for (final LlamaOption option in catalogue.options) ...option.env,
  };
}

final llamaParamsRepositoryProvider = Provider<LlamaParamsRepository>(
  (ref) => LlamaParamsRepository(ref.watch(dioProvider)),
);
