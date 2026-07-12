import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/conversation_context_usage.dart';
import '../../api/generated/models/conversation_message.dart';
import '../../api/generated/models/conversation_snapshot.dart';
import 'chat_repository.dart';

/// What the chat pane renders for one conversation. `messages` starts as the
/// snapshot's rendered list and will grow with live stream deltas (next step).
class ChatState {
  const ChatState({
    required this.snapshot,
    required this.messages,
    required this.context,
  });

  factory ChatState.fromSnapshot(ConversationSnapshot snapshot) => ChatState(
    snapshot: snapshot,
    messages: snapshot.messages,
    context: snapshot.context,
  );

  final ConversationSnapshot snapshot;
  final List<ConversationMessage> messages;
  final ConversationContextUsage context;

  String get title => snapshot.conversation.title;

  ChatState copyWith({
    List<ConversationMessage>? messages,
    ConversationContextUsage? context,
  }) => ChatState(
    snapshot: snapshot,
    messages: messages ?? this.messages,
    context: context ?? this.context,
  );
}

final chatControllerProvider =
    AsyncNotifierProvider.family<ChatController, ChatState, String>(
      ChatController.new,
    );

class ChatController extends FamilyAsyncNotifier<ChatState, String> {
  @override
  Future<ChatState> build(String conversationId) async {
    final snapshot = await ref
        .read(chatRepositoryProvider)
        .getSnapshot(conversationId);
    return ChatState.fromSnapshot(snapshot);
  }

  Future<void> reload() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() => build(arg));
  }
}
