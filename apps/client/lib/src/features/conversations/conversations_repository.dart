import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_list_item.dart';
import '../../api/generated/models/conversation_list_response.dart';

/// REST access to the conversation list + create/delete. SSE and per-conversation
/// snapshots live in the chat feature.
class ConversationsRepository {
  ConversationsRepository(this._dio);

  final Dio _dio;

  Future<ConversationListResponse> list({
    String? cursor,
    int? limit,
    String? search,
  }) async {
    final res = await _send(
      () => _dio.get<Map<String, dynamic>>(
        '/api/conversations',
        queryParameters: {
          'cursor': ?cursor,
          'limit': ?limit,
          if (search != null && search.isNotEmpty) 'search': search,
        },
      ),
    );
    return ConversationListResponse.fromJson(_asMap(res.data));
  }

  Future<ConversationListItem> create({
    String? title,
    String? defaultModelId,
  }) async {
    final res = await _send(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations',
        data: {'title': ?title, 'defaultModelId': ?defaultModelId},
      ),
    );
    return ConversationListItem.fromJson(
      _asMap(_asMap(res.data)['conversation']),
    );
  }

  Future<void> delete(String id) async {
    await _send(
      () => _dio.delete<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}',
      ),
    );
  }

  Future<Response<Map<String, dynamic>>> _send(
    Future<Response<Map<String, dynamic>>> Function() run,
  ) async {
    final Response<Map<String, dynamic>> res;
    try {
      res = await run();
    } on DioException catch (e) {
      throw NelleApiException.network(e);
    }
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw NelleApiException.fromResponse(res);
    }
    return res;
  }

  Map<String, Object?> _asMap(Object? value) =>
      value is Map ? value.cast<String, Object?>() : const {};
}

final conversationsRepositoryProvider = Provider<ConversationsRepository>(
  (ref) => ConversationsRepository(ref.watch(dioProvider)),
);
