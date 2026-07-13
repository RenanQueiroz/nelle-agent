import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Which conversation is currently being answered, and on which model.
///
/// **A model with a run streaming on it must not be touched**, and the three things the Models
/// screens offer are exactly the three that would break it: unloading it evicts the weights the
/// answer is being generated from, saving its params rewrites `models.ini` and reloads the
/// router under the run, and deleting it removes the section entirely. All three go through
/// llama.cpp, and the user is watching the reply they would kill.
///
/// The server does not police this, and should not: a live run is the one piece of state the
/// client tracks more freshly than any payload can carry (see the server-vs-client boundary
/// rule). So the client owns it, exactly as `apps/web` does.
///
/// Keyed **by conversation, not by model**, because two conversations can be answered by one
/// model at the same time — that is the whole point of `runtime.modelsMax >= 2`. A bare set of
/// model ids would be cleared by whichever run finished first and unlock a model that is still
/// generating.
final activeRunsProvider = NotifierProvider<ActiveRuns, Map<String, String>>(
  ActiveRuns.new,
);

class ActiveRuns extends Notifier<Map<String, String>> {
  @override
  Map<String, String> build() => const {};

  /// Marks [conversationId] as being answered on [modelId].
  ///
  /// Called when the run is *started*, not when the server confirms it: the model is loaded
  /// before `run.started` is emitted, and unloading it during that window is just as fatal.
  void start(String conversationId, String? modelId) {
    if (modelId == null || modelId.isEmpty) return;
    if (state[conversationId] == modelId) return;
    state = {...state, conversationId: modelId};
  }

  /// The run ended — completed, aborted, or failed. All three free the model.
  void end(String conversationId) {
    if (!state.containsKey(conversationId)) return;
    state = {...state}..remove(conversationId);
  }
}

/// The models that must not be unloaded, edited or deleted right now.
final activeRunModelIdsProvider = Provider<Set<String>>(
  (ref) => ref.watch(activeRunsProvider).values.toSet(),
);
