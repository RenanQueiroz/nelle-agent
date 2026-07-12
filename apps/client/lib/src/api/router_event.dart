/// A model-status update from llama.cpp's router SSE (`/api/llama/models/events`,
/// which the server pipes straight through from llama.cpp's `/models/sse`).
///
/// **This is not a Nelle envelope.** The shape is llama.cpp's own:
///
/// ```json
/// {"model": "<id>", "event": "status_change",
///  "data": {"status": "loading",
///           "progress": {"stages": ["text_model", "mmproj_model"],
///                        "current": "text_model", "value": 0.77}}}
/// ```
///
/// The model id is a **top-level string** (not a field inside `data`), and progress
/// is **nested** under `data.progress`. Feeding this to `ChatStreamEvent.fromEnvelope`
/// would silently mis-parse every event.
///
/// A load runs through one *stage per sub-model* (a vision model loads `text_model`
/// then `mmproj_model`), and `value` restarts at 0 for each — so `value` alone is not
/// the load's progress: it would fill the bar, snap back to zero and fill it again.
/// [progress] is therefore the fraction of the **whole** load, `(stageIndex + value) /
/// stageCount`, which is monotonic. llama.cpp also emits a bare
/// `{"stage": "mmproj_model"}` (singular, no value) between stages; it carries no
/// measurement, so it leaves progress unknown rather than resetting it.
class RouterModelEvent {
  const RouterModelEvent({required this.modelId, this.status, this.progress});

  /// Returns null for a frame that names no model — there is nothing to apply.
  static RouterModelEvent? fromJson(Map<String, dynamic> json) {
    final modelId = json['model'];
    if (modelId is! String || modelId.isEmpty) {
      return null;
    }
    final data = json['data'];
    final fields = data is Map
        ? data.cast<String, Object?>()
        : const <String, Object?>{};
    return RouterModelEvent(
      modelId: modelId,
      status: fields['status'] as String?,
      progress: _progress(fields['progress']),
    );
  }

  /// Collapses llama.cpp's staged progress into one 0..1 fraction of the whole load.
  static double? _progress(Object? progress) {
    // Tolerate a bare number, in case a future llama.cpp simplifies the shape.
    if (progress is num) {
      return progress.toDouble().clamp(0.0, 1.0);
    }
    if (progress is! Map) {
      return null;
    }
    final value = (progress['value'] as num?)?.toDouble();
    if (value == null) {
      // e.g. `{"stage": "mmproj_model"}`: a stage announcement, not a measurement.
      return null;
    }
    final stages = progress['stages'];
    final current = progress['current'];
    if (stages is! List || stages.isEmpty || current == null) {
      return value.clamp(0.0, 1.0);
    }
    final index = stages.indexOf(current);
    if (index < 0) {
      return value.clamp(0.0, 1.0);
    }
    return ((index + value.clamp(0.0, 1.0)) / stages.length).clamp(0.0, 1.0);
  }

  final String modelId;

  /// llama.cpp's own word (`unloaded`, `loading`, `loaded`, `sleeping`, …). Never an
  /// enum — a status a newer llama.cpp invents must not break us.
  final String? status;

  /// 0..1 across the *whole* load, all stages included. Null when llama.cpp sent a
  /// frame with no measurement in it.
  final double? progress;
}
