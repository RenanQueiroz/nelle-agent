import 'generated/models/chat_message.dart';
import 'generated/models/chat_performance.dart';
import 'generated/models/conversation_context_usage.dart';
import 'generated/models/nelle_error.dart';
import 'generated/models/nelle_warning.dart';
import 'generated/models/tool_call_event.dart';

/// The chat/stream events, hand-written (not codegen'd) because the wire union is
/// an 18-variant discriminated `oneOf`. The switch is on the wire `type`, which is
/// the stable contract (see AGENTS.md). Building-block payloads reuse the
/// generated DTOs. An [UnknownStreamEvent] keeps a newer server event from
/// crashing an older client.
sealed class ChatStreamEvent {
  const ChatStreamEvent();

  /// Parses a Nelle SSE envelope (`{type, ..., data: <event>}`) or a raw event
  /// (`{type, ...}`) — the server keeps both shapes and the reader tolerates both.
  factory ChatStreamEvent.fromEnvelope(Map<String, dynamic> json) {
    final inner = json['data'] is Map
        ? (json['data'] as Map).cast<String, Object?>()
        : json;
    ChatMessage message() =>
        ChatMessage.fromJson((inner['message'] as Map).cast<String, Object?>());
    String str(String k) => inner[k] as String? ?? '';

    return switch (inner['type'] as String?) {
      'run.started' => RunStartedEvent(
        runId: str('runId'),
        modelId: inner['modelId'] as String?,
        // `chat` | `regenerate` | `compact` | `title` — how the fold tells a
        // compaction from an answer, since a compaction emits no message events at all.
        kind: inner['kind'] as String?,
      ),
      'run.aborted' => RunAbortedEvent(reason: str('reason')),
      'run.completed' => RunCompletedEvent(
        status: str('status'),
        error: inner['error'] is Map
            ? NelleError.fromJson(
                (inner['error'] as Map).cast<String, Object?>(),
              )
            : null,
      ),
      'model.loading' => ModelLoadingEvent(
        modelId: str('modelId'),
        status: str('status'),
        progress: (inner['progress'] as num?)?.toDouble(),
        phase: inner['phase'] as String?,
        downloadedBytes: (inner['downloadedBytes'] as num?)?.toInt(),
        totalBytes: (inner['totalBytes'] as num?)?.toInt(),
      ),
      'message.user.created' => UserMessageCreatedEvent(message()),
      'message.assistant.started' => AssistantStartedEvent(message()),
      'message.assistant.delta' => AssistantDeltaEvent(
        id: str('id'),
        delta: str('delta'),
      ),
      'message.assistant.reasoning_delta' => AssistantReasoningDeltaEvent(
        id: str('id'),
        delta: str('delta'),
      ),
      'message.assistant.completed' => AssistantCompletedEvent(message()),
      'performance.updated' => PerformanceUpdatedEvent(
        id: str('id'),
        performance: ChatPerformance.fromJson(
          (inner['performance'] as Map).cast<String, Object?>(),
        ),
      ),
      'tool_call.updated' => ToolCallUpdatedEvent(
        ToolCallEvent.fromJson((inner['call'] as Map).cast<String, Object?>()),
      ),
      'context.updated' => ContextUpdatedEvent(
        ConversationContextUsage.fromJson(inner),
      ),
      'conversation.updated' => ConversationUpdatedEvent(
        title: inner['title'] as String?,
      ),
      'run.warning' => RunWarningEvent(NelleWarning.fromJson(inner)),
      'compact.started' => CompactStartedEvent(
        runId: str('runId'),
        instructions: inner['instructions'] as String?,
      ),
      'compact.completed' => CompactCompletedEvent(
        runId: str('runId'),
        compacted: inner['compacted'] as bool? ?? false,
      ),
      'compact.failed' => CompactFailedEvent(
        runId: str('runId'),
        error: NelleError.fromJson(
          (inner['error'] as Map? ?? const {}).cast<String, Object?>(),
        ),
      ),
      'error' => StreamErrorEvent(NelleError.fromJson(inner)),
      final type => UnknownStreamEvent(type ?? 'unknown'),
    };
  }
}

class RunStartedEvent extends ChatStreamEvent {
  const RunStartedEvent({required this.runId, this.modelId, this.kind});
  final String runId;
  final String? modelId;

  /// `chat` | `regenerate` | `compact` | `title`. A compaction run emits no
  /// `message.*` at all, so this is how the fold knows what it is watching.
  final String? kind;
}

/// A compaction began. `compact.*` used to land in [UnknownStreamEvent], which is why
/// that member exists.
class CompactStartedEvent extends ChatStreamEvent {
  const CompactStartedEvent({required this.runId, this.instructions});
  final String runId;
  final String? instructions;
}

class CompactCompletedEvent extends ChatStreamEvent {
  const CompactCompletedEvent({required this.runId, required this.compacted});
  final String runId;
  final bool compacted;

  // `tokensBefore`, `firstKeptEntryId` and `summaryPreview` are declared by the server's
  // schema and never populated (`piHarness.ts:2006` emits none of them). Building UI on
  // them would render nothing, so they are deliberately absent here too.
}

class CompactFailedEvent extends ChatStreamEvent {
  const CompactFailedEvent({required this.runId, required this.error});
  final String runId;
  final NelleError error;
}

class RunAbortedEvent extends ChatStreamEvent {
  const RunAbortedEvent({required this.reason});
  final String reason;
}

class RunCompletedEvent extends ChatStreamEvent {
  const RunCompletedEvent({required this.status, this.error});
  final String status;
  final NelleError? error;
}

class ModelLoadingEvent extends ChatStreamEvent {
  const ModelLoadingEvent({
    required this.modelId,
    required this.status,
    this.progress,
    this.phase,
    this.downloadedBytes,
    this.totalBytes,
  });
  final String modelId;
  final String status;
  final double? progress;

  /// `downloading` while the weights are still arriving (a first load pulls multi-GB blobs),
  /// `loading` once llama.cpp reads them in, null on the first quiet ticks. Kept a plain
  /// string so a phase this client has never heard of degrades to the generic placeholder
  /// instead of failing the parse.
  final String? phase;
  final int? downloadedBytes;
  final int? totalBytes;
}

class UserMessageCreatedEvent extends ChatStreamEvent {
  const UserMessageCreatedEvent(this.message);
  final ChatMessage message;
}

class AssistantStartedEvent extends ChatStreamEvent {
  const AssistantStartedEvent(this.message);
  final ChatMessage message;
}

class AssistantDeltaEvent extends ChatStreamEvent {
  const AssistantDeltaEvent({required this.id, required this.delta});
  final String id;
  final String delta;
}

class AssistantReasoningDeltaEvent extends ChatStreamEvent {
  const AssistantReasoningDeltaEvent({required this.id, required this.delta});
  final String id;
  final String delta;
}

class AssistantCompletedEvent extends ChatStreamEvent {
  const AssistantCompletedEvent(this.message);
  final ChatMessage message;
}

class PerformanceUpdatedEvent extends ChatStreamEvent {
  const PerformanceUpdatedEvent({required this.id, required this.performance});
  final String id;
  final ChatPerformance performance;
}

class ToolCallUpdatedEvent extends ChatStreamEvent {
  const ToolCallUpdatedEvent(this.call);
  final ToolCallEvent call;
}

class ContextUpdatedEvent extends ChatStreamEvent {
  const ContextUpdatedEvent(this.usage);
  final ConversationContextUsage usage;
}

class ConversationUpdatedEvent extends ChatStreamEvent {
  const ConversationUpdatedEvent({this.title});
  final String? title;
}

class RunWarningEvent extends ChatStreamEvent {
  const RunWarningEvent(this.warning);
  final NelleWarning warning;
}

class StreamErrorEvent extends ChatStreamEvent {
  const StreamErrorEvent(this.error);
  final NelleError error;
}

class UnknownStreamEvent extends ChatStreamEvent {
  const UnknownStreamEvent(this.type);
  final String type;
}
