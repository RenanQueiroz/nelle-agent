import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_snapshot.dart';
import '../../api/generated/models/reasoning_level.dart';

/// Reads a conversation snapshot and applies the conversation-level settings a run
/// reads (its model, its reasoning level).
///
/// Every mutation answers with the server's own snapshot, and the caller applies it
/// verbatim: the client never guesses what a write did.
class ChatRepository {
  ChatRepository(this._dio);

  final Dio _dio;

  Future<ConversationSnapshot> getSnapshot(String conversationId) =>
      _snapshot(
        () => _dio.get<Map<String, dynamic>>(_path(conversationId)),
      );

  /// Pins the conversation to [modelId]. The run reads the *conversation's* model,
  /// so this — not activating a global model — is what makes this chat answer on it.
  Future<ConversationSnapshot> setModel(
    String conversationId,
    String modelId,
  ) => _snapshot(
    () => _dio.patch<Map<String, dynamic>>(
      _path(conversationId),
      data: {'defaultModelId': modelId},
    ),
  );

  /// Sets how hard the model thinks on this conversation. Reasoning is per
  /// conversation, not global: Pi is told the level before every prompt.
  ///
  /// [level] must be a level this build knows — `toJson()` throws on `$unknown`,
  /// which is what a *newer* server's level deserializes to and is not ours to echo
  /// back.
  Future<ConversationSnapshot> setReasoningLevel(
    String conversationId,
    ReasoningLevel level,
  ) => _snapshot(
    () => _dio.put<Map<String, dynamic>>(
      '${_path(conversationId)}/reasoning',
      data: {'level': level.toJson()},
    ),
  );

  String _path(String conversationId) =>
      '/api/conversations/${Uri.encodeComponent(conversationId)}';

  Future<ConversationSnapshot> _snapshot(
    Future<Response<Map<String, dynamic>>> Function() send,
  ) async {
    final Response<Map<String, dynamic>> res;
    try {
      res = await send();
    } on DioException catch (e) {
      throw NelleApiException.network(e);
    }
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw NelleApiException.fromResponse(res);
    }
    final snapshot = (res.data ?? const {})['snapshot'];
    if (snapshot is! Map) {
      throw NelleApiException('Malformed snapshot response', statusCode: code);
    }
    return ConversationSnapshot.fromJson(snapshot.cast<String, Object?>());
  }
}

final chatRepositoryProvider = Provider<ChatRepository>(
  (ref) => ChatRepository(ref.watch(dioProvider)),
);
