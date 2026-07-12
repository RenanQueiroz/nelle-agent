import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/chat_stream_event.dart';
import '../../api/generated/models/conversation_context_usage.dart';
import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_message_role.dart';
import '../../api/generated/models/conversation_snapshot.dart';
import 'chat_repository.dart';
import 'sse_transport.dart';

/// What the chat pane renders. `messages` is the snapshot's rendered list;
/// `pending` holds the optimistic user turn + the streaming assistant turn during
/// a run, and is cleared when the run finishes and the snapshot is reloaded.
class ChatState {
  const ChatState({
    required this.snapshot,
    required this.messages,
    required this.context,
    this.pending = const [],
    this.running = false,
    this.modelLoadProgress,
    this.runError,
  });

  factory ChatState.fromSnapshot(ConversationSnapshot snapshot) => ChatState(
    snapshot: snapshot,
    messages: snapshot.messages,
    context: snapshot.context,
  );

  final ConversationSnapshot snapshot;
  final List<ConversationMessage> messages;
  final ConversationContextUsage context;
  final List<ConversationMessage> pending;
  final bool running;

  /// Non-null (0..1) while llama.cpp is loading the model's weights for this run.
  final double? modelLoadProgress;
  final String? runError;

  String get title => snapshot.conversation.title;
  bool get loadingModel => modelLoadProgress != null;
  List<ConversationMessage> get rendered => [...messages, ...pending];

  ChatState copyWith({
    List<ConversationMessage>? messages,
    ConversationContextUsage? context,
    List<ConversationMessage>? pending,
    bool? running,
    double? modelLoadProgress,
    bool clearModelLoad = false,
    String? runError,
    bool clearError = false,
  }) => ChatState(
    snapshot: snapshot,
    messages: messages ?? this.messages,
    context: context ?? this.context,
    pending: pending ?? this.pending,
    running: running ?? this.running,
    modelLoadProgress: clearModelLoad
        ? null
        : (modelLoadProgress ?? this.modelLoadProgress),
    runError: clearError ? null : (runError ?? this.runError),
  );
}

final chatControllerProvider =
    AsyncNotifierProvider.family<ChatController, ChatState, String>(
      ChatController.new,
    );

class ChatController extends FamilyAsyncNotifier<ChatState, String> {
  StreamSubscription<ChatStreamEvent>? _sub;
  CancelToken? _cancel;

  @override
  Future<ChatState> build(String conversationId) async {
    ref.onDispose(() {
      _sub?.cancel();
      _cancel?.cancel();
    });
    final snapshot = await ref
        .read(chatRepositoryProvider)
        .getSnapshot(conversationId);
    return ChatState.fromSnapshot(snapshot);
  }

  /// Sends [text], appends an optimistic user turn + empty assistant turn, and
  /// folds the SSE stream into the assistant turn until the run finishes.
  Future<void> send(String text) async {
    final current = state.valueOrNull;
    final message = text.trim();
    if (current == null || current.running || message.isEmpty) {
      return;
    }
    final now = DateTime.now().toUtc().toIso8601String();
    final user = ConversationMessage(
      id: 'local-user-$now',
      role: ConversationMessageRole.user,
      content: message,
      createdAt: now,
    );
    final assistant = ConversationMessage(
      id: 'local-assistant-$now',
      role: ConversationMessageRole.assistant,
      content: '',
      createdAt: now,
    );
    state = AsyncData(
      current.copyWith(
        pending: [user, assistant],
        running: true,
        clearError: true,
        clearModelLoad: true,
      ),
    );

    _cancel = CancelToken();
    _sub = ref
        .read(sseTransportProvider)
        .stream(
          '/api/conversations/${Uri.encodeComponent(arg)}/chat/stream',
          body: {'message': message},
          cancelToken: _cancel,
        )
        .listen(
          _onEvent,
          onError: _onStreamError,
          onDone: _finish,
          cancelOnError: false,
        );
  }

  /// Stops the active run: aborts the upstream fetch and tells the server.
  Future<void> abort() async {
    if (_sub == null) {
      return;
    }
    _cancel?.cancel();
    try {
      await ref
          .read(dioProvider)
          .post<Map<String, dynamic>>(
            '/api/conversations/${Uri.encodeComponent(arg)}/abort',
          );
    } catch (_) {
      // The stream cancel already stopped the client; _finish reloads state.
    }
  }

  Future<void> reload() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => build(arg));
  }

  void _onEvent(ChatStreamEvent event) {
    final s = state.valueOrNull;
    if (s == null) {
      return;
    }
    switch (event) {
      case ModelLoadingEvent(:final progress):
        state = AsyncData(s.copyWith(modelLoadProgress: progress ?? 0.0));
      case AssistantDeltaEvent(:final delta):
        state = AsyncData(
          s.copyWith(
            clearModelLoad: true,
            pending: _appendToAssistant(s.pending, content: delta),
          ),
        );
      case AssistantReasoningDeltaEvent(:final delta):
        state = AsyncData(
          s.copyWith(
            clearModelLoad: true,
            pending: _appendToAssistant(s.pending, reasoning: delta),
          ),
        );
      case ContextUpdatedEvent(:final usage):
        state = AsyncData(s.copyWith(context: usage));
      case StreamErrorEvent(:final error):
        state = AsyncData(s.copyWith(runError: error.message));
      case RunCompletedEvent(:final status, :final error):
        _finish(
          errorMessage:
              error?.message ?? (status == 'failed' ? 'The run failed.' : null),
        );
      case RunAbortedEvent():
        _finish();
      default:
        // run.started, message.*, performance, tool_call, conversation.updated,
        // run.warning, unknown — not folded in M1.
        break;
    }
  }

  List<ConversationMessage> _appendToAssistant(
    List<ConversationMessage> pending, {
    String? content,
    String? reasoning,
  }) {
    if (pending.isEmpty) {
      return pending;
    }
    final list = [...pending];
    final last = list.last;
    list[list.length - 1] = _reconstruct(
      last,
      content: content == null ? null : '${last.content}$content',
      reasoning: reasoning == null ? null : '${last.reasoning ?? ''}$reasoning',
    );
    return list;
  }

  ConversationMessage _reconstruct(
    ConversationMessage m, {
    String? content,
    String? reasoning,
  }) => ConversationMessage(
    id: m.id,
    role: m.role,
    content: content ?? m.content,
    createdAt: m.createdAt,
    parentPiEntryId: m.parentPiEntryId,
    modelId: m.modelId,
    modelRuntimeId: m.modelRuntimeId,
    modelAliasSnapshot: m.modelAliasSnapshot,
    regeneratesPiEntryId: m.regeneratesPiEntryId,
    displayGroupId: m.displayGroupId,
    variantLabel: m.variantLabel,
    performance: m.performance,
    toolCalls: m.toolCalls,
    reasoning: reasoning ?? m.reasoning,
    attachments: m.attachments,
  );

  void _onStreamError(Object error, StackTrace stackTrace) {
    final s = state.valueOrNull;
    final message = error is NelleApiException
        ? error.message
        : error.toString();
    _finish(errorMessage: s?.runError ?? message);
  }

  /// Runs once per run: cancels the subscription, then reloads the authoritative
  /// snapshot. If the reload fails, the streamed `pending` turns are merged into
  /// `messages` so nothing is lost.
  Future<void> _finish({String? errorMessage}) async {
    final sub = _sub;
    if (sub == null) {
      return;
    }
    _sub = null;
    await sub.cancel();
    _cancel = null;

    final s = state.valueOrNull;
    final error = errorMessage ?? s?.runError;
    try {
      final snapshot = await ref.read(chatRepositoryProvider).getSnapshot(arg);
      final next = ChatState.fromSnapshot(snapshot);
      state = AsyncData(error == null ? next : next.copyWith(runError: error));
    } catch (_) {
      if (s != null) {
        state = AsyncData(
          s.copyWith(
            running: false,
            clearModelLoad: true,
            messages: [...s.messages, ...s.pending],
            pending: const [],
            runError: error,
          ),
        );
      }
    }
  }
}
