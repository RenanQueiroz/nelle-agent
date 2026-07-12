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
      'error' => StreamErrorEvent(NelleError.fromJson(inner)),
      final type => UnknownStreamEvent(type ?? 'unknown'),
    };
  }
}

class RunStartedEvent extends ChatStreamEvent {
  const RunStartedEvent({required this.runId, this.modelId});
  final String runId;
  final String? modelId;
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
  });
  final String modelId;
  final String status;
  final double? progress;
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
