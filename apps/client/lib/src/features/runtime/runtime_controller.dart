import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/llama_router_props.dart';
import '../../api/generated/models/nelle_error.dart';
import '../../api/generated/models/runtime_status.dart';
import '../../api/runtime_install_event.dart';
import 'runtime_repository.dart';

/// The runtime's status. [refresh] after anything that could move it.
final runtimeStatusProvider =
    AsyncNotifierProvider<RuntimeStatusNotifier, RuntimeStatus>(
      RuntimeStatusNotifier.new,
    );

class RuntimeStatusNotifier extends AsyncNotifier<RuntimeStatus> {
  @override
  Future<RuntimeStatus> build() =>
      // `checkLatest` costs a GitHub round trip, and it is the only way to know whether an
      // update exists. `apps/web` never once asked for it, so its Update button could not
      // tell you whether there was anything to update to.
      ref.watch(runtimeRepositoryProvider).status(checkLatest: true);

  Future<void> refresh() async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(
      () => ref.read(runtimeRepositoryProvider).status(checkLatest: true),
    );
  }

  Future<void> start() => _act((repo) => repo.start());
  Future<void> stop() => _act((repo) => repo.stop());

  /// Deletes the installed binary (and, on Linux, the cloned source). Unlike start/stop this is
  /// **destructive**, so it does not go through `_act`: `AsyncValue.guard` would swallow a refusal
  /// into the state and the button would silently do nothing. It applies the uninstalled status on
  /// success and **rethrows** on failure, so the caller can surface it; the state is refetched so
  /// the screen reflects reality either way.
  Future<void> uninstall() async {
    state = const AsyncValue.loading();
    try {
      final status = await ref.read(runtimeRepositoryProvider).uninstall();
      state = AsyncValue.data(status);
      ref.invalidate(routerPropsProvider);
    } catch (_) {
      state = await AsyncValue.guard(
        () => ref.read(runtimeRepositoryProvider).status(checkLatest: true),
      );
      rethrow;
    }
  }

  /// Applies a status the server already handed us — the install stream's terminal event
  /// carries one, so there is nothing to refetch.
  void apply(RuntimeStatus status) => state = AsyncValue.data(status);

  Future<void> _act(
    Future<RuntimeStatus> Function(RuntimeRepository) run,
  ) async {
    state = const AsyncValue.loading();
    state = await AsyncValue.guard(
      () => run(ref.read(runtimeRepositoryProvider)),
    );
    // Starting or stopping llama.cpp changes what the router can say about anything.
    ref.invalidate(routerPropsProvider);
  }
}

/// llama.cpp's router. 502s when it is stopped — a state, not a crash, so the screen shows
/// "router stopped" rather than an error.
final routerPropsProvider = FutureProvider<LlamaRouterProps?>((ref) async {
  try {
    return await ref.watch(runtimeRepositoryProvider).props();
  } catch (_) {
    return null;
  }
});

/// What an install is doing right now.
class InstallState {
  const InstallState({
    this.running = false,
    this.lines = const [],
    this.error,
    this.finished = false,
  });

  final bool running;

  /// The build's own output, in arrival order.
  ///
  /// **`isStderr` is a stream label, not a verdict.** cmake and git narrate progress there —
  /// a real llama.cpp build emitted 820 stdout lines and 2 stderr, and succeeded. Do not
  /// paint it red, and do not decide a build failed because it wrote to stderr. Only
  /// [error] says that.
  final List<InstallOutputEvent> lines;

  /// Set only by `runtime.install.failed`. Nothing else means failure.
  final NelleError? error;
  final bool finished;

  InstallState copyWith({
    bool? running,
    List<InstallOutputEvent>? lines,
    NelleError? error,
    bool? finished,
  }) => InstallState(
    running: running ?? this.running,
    lines: lines ?? this.lines,
    error: error ?? this.error,
    finished: finished ?? this.finished,
  );
}

/// Drives `POST /api/runtime/install/stream`.
///
/// It lives in a provider, not in a screen's state, **on purpose**: a source build takes
/// minutes, and a user who navigates away from the console must not lose it — nor kill it.
/// There is no way to re-attach to an install already in flight, so the stream has to outlive
/// the widget that started it.
final installControllerProvider =
    NotifierProvider<InstallController, InstallState>(InstallController.new);

class InstallController extends Notifier<InstallState> {
  StreamSubscription<RuntimeInstallEvent>? _subscription;

  @override
  InstallState build() {
    ref.onDispose(() => _subscription?.cancel());
    return const InstallState();
  }

  /// Starts a build. A second call while one is running is a no-op — the *server* refuses it
  /// too (`runtime_install_in_progress`), because two builds would delete each other's
  /// `build/` directory.
  ///
  /// [version] installs that specific upstream version — the revert path, fed by
  /// `RuntimeStatus.previousVersion` when a fresh install goes bad.
  void start({String? version}) {
    if (state.running) return;
    state = const InstallState(running: true);

    _subscription?.cancel();
    _subscription = ref
        .read(runtimeRepositoryProvider)
        .install(version: version)
        .listen(
          _apply,
          onError: (Object error) {
            state = state.copyWith(
              running: false,
              finished: true,
              error: NelleError(
                code: 'runtime_install_failed',
                message: '$error',
              ),
            );
          },
          onDone: () {
            // A stream that ends without a terminal event: the server went away mid-build.
            if (state.running) {
              state = state.copyWith(running: false, finished: true);
            }
          },
        );
  }

  void _apply(RuntimeInstallEvent event) {
    switch (event) {
      case InstallStartedEvent():
        break;
      case InstallOutputEvent():
        state = state.copyWith(lines: [...state.lines, event]);
      case InstallCompletedEvent(:final runtime):
        state = state.copyWith(running: false, finished: true);
        // The terminal event *carries* the status, so there is nothing to refetch.
        ref.read(runtimeStatusProvider.notifier).apply(runtime);
      case InstallFailedEvent(:final error):
        state = state.copyWith(running: false, finished: true, error: error);
      case UnknownInstallEvent():
        // A newer server invented an event. Ignoring it is always safe; crashing ten minutes
        // into a build is not.
        break;
    }
  }
}
