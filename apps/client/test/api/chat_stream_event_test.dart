import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/chat_stream_event.dart';

void main() {
  // Wraps an event in the Nelle SSE envelope, like the server does.
  ChatStreamEvent enveloped(Map<String, dynamic> event) =>
      ChatStreamEvent.fromEnvelope(<String, dynamic>{
        'id': 'e',
        'type': event['type'],
        'createdAt': 't',
        'data': event,
      });

  const chatMessage = <String, dynamic>{
    'id': 'm',
    'role': 'assistant',
    'content': 'hi',
    'createdAt': 't',
  };

  group('ChatStreamEvent.fromEnvelope', () {
    test('error (the real llama_server_stopped frame)', () {
      final event = ChatStreamEvent.fromEnvelope(<String, dynamic>{
        'id': 'x',
        'type': 'error',
        'createdAt': 't',
        'data': {
          'type': 'error',
          'code': 'llama_server_stopped',
          'message': 'not running',
          'retryable': true,
        },
      });
      expect(event, isA<StreamErrorEvent>());
      expect((event as StreamErrorEvent).error.code, 'llama_server_stopped');
      expect(event.error.message, 'not running');
    });

    test('assistant delta and reasoning delta', () {
      final delta = enveloped({
        'type': 'message.assistant.delta',
        'id': 'm',
        'delta': 'Hello',
        'isReasoning': false,
      });
      expect((delta as AssistantDeltaEvent).delta, 'Hello');

      final reasoning = enveloped({
        'type': 'message.assistant.reasoning_delta',
        'id': 'm',
        'delta': 'think',
        'isReasoning': true,
      });
      expect((reasoning as AssistantReasoningDeltaEvent).delta, 'think');
    });

    test('model.loading carries progress', () {
      final event = enveloped({
        'type': 'model.loading',
        'conversationId': 'c',
        'modelId': 'm',
        'status': 'loading',
        'progress': 0.42,
      });
      expect((event as ModelLoadingEvent).progress, 0.42);
    });

    test('run lifecycle', () {
      expect(
        enveloped({
          'type': 'run.started',
          'runId': 'r',
          'kind': 'chat',
          'status': 'running',
        }),
        isA<RunStartedEvent>(),
      );
      expect(
        enveloped({'type': 'run.aborted', 'reason': 'user'}),
        isA<RunAbortedEvent>(),
      );
      final completed = enveloped({
        'type': 'run.completed',
        'status': 'completed',
      });
      expect((completed as RunCompletedEvent).status, 'completed');
    });

    test('run.completed can carry an error', () {
      final event = enveloped({
        'type': 'run.completed',
        'status': 'failed',
        'error': {'code': 'context_overflow', 'message': 'too big'},
      });
      expect((event as RunCompletedEvent).error?.code, 'context_overflow');
    });

    test('message events carry a ChatMessage', () {
      expect(
        enveloped({
          'type': 'message.user.created',
          'message': {...chatMessage, 'role': 'user'},
        }),
        isA<UserMessageCreatedEvent>(),
      );
      expect(
        enveloped({
          'type': 'message.assistant.started',
          'message': chatMessage,
          'harness': 'pi',
        }),
        isA<AssistantStartedEvent>(),
      );
      final completed = enveloped({
        'type': 'message.assistant.completed',
        'message': chatMessage,
      });
      expect((completed as AssistantCompletedEvent).message.content, 'hi');
    });

    test('performance and tool_call', () {
      expect(
        enveloped({
          'type': 'performance.updated',
          'id': 'm',
          'performance': {'source': 'llamacpp-timings'},
        }),
        isA<PerformanceUpdatedEvent>(),
      );
      final tool = enveloped({
        'type': 'tool_call.updated',
        'call': {'id': 't1', 'name': 'read', 'status': 'running'},
      });
      expect((tool as ToolCallUpdatedEvent).call.name, 'read');
    });

    test('context.updated reads usage from the event body', () {
      final event = enveloped({
        'type': 'context.updated',
        'conversationId': 'c',
        'usedTokens': 10,
        'totalTokens': 100,
        'status': 'warning',
      });
      final usage = (event as ContextUpdatedEvent).usage;
      expect(usage.usedTokens, 10);
      expect(usage.totalTokens, 100);
    });

    test('conversation.updated and run.warning', () {
      expect(
        enveloped({
          'type': 'conversation.updated',
          'conversationId': 'c',
          'title': 'New',
        }),
        isA<ConversationUpdatedEvent>(),
      );
      expect(
        enveloped({
          'type': 'run.warning',
          'code': 'llama_slot_still_processing',
          'message': 'busy',
        }),
        isA<RunWarningEvent>(),
      );
    });

    test('accepts a raw (unenveloped) event', () {
      final event = ChatStreamEvent.fromEnvelope(<String, dynamic>{
        'type': 'message.assistant.delta',
        'id': 'm',
        'delta': 'Hi',
        'isReasoning': false,
      });
      expect((event as AssistantDeltaEvent).delta, 'Hi');
    });

    test('an unknown type never crashes the client', () {
      final event = enveloped({'type': 'future.thing'});
      expect((event as UnknownStreamEvent).type, 'future.thing');
    });
  });
}
