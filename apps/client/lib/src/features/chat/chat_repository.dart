import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_snapshot.dart';

/// Reads a conversation snapshot. Sending/streaming lives in the chat controller
/// + SSE transport (next step).
class ChatRepository {
  ChatRepository(this._dio);

  final Dio _dio;

  Future<ConversationSnapshot> getSnapshot(String conversationId) async {
    final Response<Map<String, dynamic>> res;
    try {
      res = await _dio.get<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(conversationId)}',
      );
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
