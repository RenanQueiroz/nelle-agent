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
  /// How long to wait before reattaching a dropped stream, and its ceiling. llama.cpp
  /// being down is an ordinary state, not an error, so this retries forever — at one
  /// request per [_maxRetry] once it has backed off.
  static const _minRetry = Duration(seconds: 2);
  static const _maxRetry = Duration(seconds: 15);

  StreamSubscription<Map<String, dynamic>>? _sub;
  CancelToken? _cancel;
  Timer? _retry;
  Duration _backoff = _minRetry;
  bool _disposed = false;

  @override
  Future<List<LlamaRouterModel>> build() async {
    ref.onDispose(() {
      _disposed = true;
      _retry?.cancel();
      _sub?.cancel();
      _cancel?.cancel();
    });
    final models = await ref.read(llamaRepositoryProvider).list();
    _listen();
    return models;
  }

  /// Subscribes to the router's raw llama.cpp event stream. A failure just means
  /// llama.cpp is not running: the list stays as-is rather than blowing up the UI, and
  /// the stream is reattached so a llama.cpp that comes back is picked up on its own.
  void _listen() {
    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .streamJson('/api/llama/models/events', cancelToken: _cancel)
        .listen(
          (event) {
            _backoff = _minRetry;
            _apply(event);
          },
          // Both paths matter: llama.cpp stopping *ends* the stream rather than
          // failing it, and without a reattach the status shown here would freeze at
          // whatever it last saw — for the rest of the session.
          onError: (Object _) => _reattachLater(),
          onDone: _reattachLater,
          cancelOnError: false,
        );
  }

  void _reattachLater() {
    if (_disposed || _retry != null) {
      return;
    }
    _sub?.cancel();
    _sub = null;
    _cancel?.cancel();
    _cancel = null;

    _retry = Timer(_backoff, () async {
      _retry = null;
      if (_disposed) {
        return;
      }
      _backoff = _backoff * 2 > _maxRetry ? _maxRetry : _backoff * 2;
      try {
        // llama.cpp may have restarted with a different set of models, so re-list
        // rather than reattaching the stream to a stale one.
        final models = await ref.read(llamaRepositoryProvider).list();
        if (_disposed) {
          return;
        }
        _backoff = _minRetry;
        state = AsyncData(models);
        _listen();
      } catch (_) {
        // Still down. Try again, more slowly.
        _reattachLater();
      }
    });
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
    final progress = _nextProgress(event, current, status);

    // The whole point: nothing the UI renders changed, so do not rebuild it.
    if (status == current.status && progress == current.progress) {
      return;
    }

    final next = [...models];
    next[index] = _withRouterState(current, status: status, progress: progress);
    state = AsyncData(next);
  }

  /// Progress belongs to a load in flight, so it lives and dies with the `loading`
  /// status. Carrying it past one would leave a loaded model holding the last
  /// percentage it reported, ready to resurface as a stale number on its next load.
  num? _nextProgress(
    RouterModelEvent event,
    LlamaRouterModel current,
    String status,
  ) {
    if (status.toLowerCase() != 'loading') {
      return null;
    }
    if (event.progress != null) {
      return event.progress;
    }
    // A frame with no measurement (llama.cpp's bare `{"stage": ...}`) must not reset a
    // load that is already reporting; but entering `loading` starts from nothing.
    return current.status.toLowerCase() == 'loading' ? current.progress : null;
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


/// What to *show* for a model's router status — three different things, and conflating any two
/// of them is a bug that has already been made twice.
///
/// - `listed == null`: llama.cpp is **stopped**. There is no router to ask.
/// - `router == null`: llama.cpp is running and this model is **not in the list we hold**. The
///   server seeds every configured section into the router list, so this means our cached list is
///   simply older than the import — not that llama.cpp is down. Saying "llama.cpp stopped" here
///   told a freshly imported model that the runtime was off while it was plainly running, *and*
///   left its Load button disabled, so it could never be loaded at all.
/// - otherwise: llama.cpp's own word, which is free-form on purpose — a status a newer llama.cpp
///   invents must not break a client that only renders it.
///
/// Shared, because the list screen learned this and the detail screen then made the same mistake
/// independently. One rule, one place.
String routerStatusLabel(
  LlamaRouterModel? router, {
  required List<LlamaRouterModel>? listed,
}) {
  if (listed == null) return 'llama.cpp stopped';
  if (router == null) return 'not listed yet';
  if (router.status == 'loading') {
    final progress = router.progress;
    // `undefined` means "loading, amount unknown" — and it is never zero. Inventing a 0% the
    // server never sent is worse than saying nothing.
    return progress == null
        ? 'loading'
        : 'loading ${(progress * 100).round()}%';
  }
  return router.status;
}
