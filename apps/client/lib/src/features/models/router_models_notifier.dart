import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/llama_router_model.dart';
import '../../api/router_event.dart';
import '../chat/sse_transport.dart';
import 'llama_repository.dart';

/// The router's model list, kept live by llama.cpp's `/models/events` SSE.
///
/// **Only emits when a field the UI renders actually changed.** Every router event
/// carries a fresh payload, so applying them blindly would rebuild the selector on
/// every heartbeat — which is why the contract deliberately drops llama.cpp's `raw`
/// blob and why this compares `status` and `progress` before writing state.
class RouterModelsNotifier extends AsyncNotifier<List<LlamaRouterModel>> {
  StreamSubscription<Map<String, dynamic>>? _sub;
  CancelToken? _cancel;

  @override
  Future<List<LlamaRouterModel>> build() async {
    ref.onDispose(() {
      _sub?.cancel();
      _cancel?.cancel();
    });
    final models = await ref.read(llamaRepositoryProvider).list();
    _listen();
    return models;
  }

  /// Subscribes to the router's raw llama.cpp event stream. A failure just means
  /// llama.cpp is not running: the list stays as-is rather than blowing up the UI.
  void _listen() {
    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .streamJson('/api/llama/models/events', cancelToken: _cancel)
        .listen(
          _apply,
          onError: (Object _) {
            // llama.cpp stopped or the stream dropped. Not fatal; a refresh reattaches.
          },
          cancelOnError: false,
        );
  }

  void _apply(Map<String, dynamic> json) {
    final event = RouterModelEvent.fromJson(json);
    final models = state.valueOrNull;
    if (event == null || models == null) {
      return;
    }
    final index = models.indexWhere((m) => _matches(m, event.modelId));
    if (index < 0) {
      return;
    }
    final current = models[index];
    final status = event.status ?? current.status;
    final progress = event.progress ?? current.progress;

    // The whole point: nothing the UI renders changed, so do not rebuild it.
    if (status == current.status && progress == current.progress) {
      return;
    }

    final next = [...models];
    next[index] = _withRouterState(current, status: status, progress: progress);
    state = AsyncData(next);
  }

  /// llama.cpp names the model by its router id, which is Nelle's canonical section
  /// id — but tolerate the router id and aliases too.
  bool _matches(LlamaRouterModel model, String id) =>
      model.sectionId == id ||
      model.routerModelId == id ||
      model.aliases.contains(id);

  /// The generated DTO has no copyWith, so rebuild it field by field.
  LlamaRouterModel _withRouterState(
    LlamaRouterModel m, {
    required String status,
    required num? progress,
  }) => LlamaRouterModel(
    sectionId: m.sectionId,
    routerModelId: m.routerModelId,
    alias: m.alias,
    hfRepo: m.hfRepo,
    status: status,
    progress: progress,
    aliases: m.aliases,
    source: m.source,
    canRemove: m.canRemove,
    architecture: m.architecture,
    contextWindow: m.contextWindow,
    contextTrain: m.contextTrain,
    parameterCount: m.parameterCount,
  );

  /// Re-fetches the list and reattaches the event stream (e.g. after llama.cpp
  /// starts).
  Future<void> refresh() async {
    await _sub?.cancel();
    _sub = null;
    _cancel?.cancel();
    _cancel = null;
    state = const AsyncLoading();
    state = await AsyncValue.guard(build);
  }
}

final routerModelsProvider =
    AsyncNotifierProvider<RouterModelsNotifier, List<LlamaRouterModel>>(
      RouterModelsNotifier.new,
    );

/// A model is runnable when llama.cpp already has it (or can wake it) — used to
/// decide whether warming it early is worth a request.
bool isRunnableRouterStatus(String status) {
  final s = status.toLowerCase();
  return s == 'loaded' || s == 'ready' || s == 'sleeping';
}
