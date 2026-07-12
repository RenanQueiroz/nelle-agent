/// A model-status update from llama.cpp's router SSE (`/api/llama/models/events`,
/// which the server pipes straight through from llama.cpp's `/models/sse`).
///
/// **This is not a Nelle envelope.** The shape is llama.cpp's own:
///
/// ```json
/// {"model": "<id>", "data": {"status": "loading", "progress": {"value": 0.67}}}
/// ```
///
/// The model id is a **top-level string** (not a field inside `data`), and progress
/// is **nested** at `data.progress.value`. Feeding this to
/// `ChatStreamEvent.fromEnvelope` would silently mis-parse every event.
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
    final progress = fields['progress'];
    return RouterModelEvent(
      modelId: modelId,
      status: fields['status'] as String?,
      // Nested `{value: 0.67}` is the shape llama.cpp sends; tolerate a bare number.
      progress: progress is Map
          ? (progress['value'] as num?)?.toDouble()
          : (progress as num?)?.toDouble(),
    );
  }

  final String modelId;

  /// llama.cpp's own word (`unloaded`, `loading`, `loaded`, `sleeping`, …). Never an
  /// enum — a status a newer llama.cpp invents must not break us.
  final String? status;

  /// 0..1 while the weights load.
  final double? progress;
}
