import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/generated/models/conversation_created_response.dart';
import '../../api/generated/models/conversation_diagnostics.dart';
import '../../api/generated/models/conversation_list_item.dart';
import '../../api/generated/models/conversation_list_response.dart';
import '../../api/generated/models/conversation_snapshot.dart';
import '../../api/request.dart';

/// The whole conversation lifecycle: list, create, rename, pin, fork, clone, export, import,
/// repair, rebuild, diagnostics, delete.
///
/// SSE and per-conversation snapshots live in the chat feature; this is the REST surface.
class ConversationsRepository {
  ConversationsRepository(this._dio);

  final Dio _dio;

  Future<ConversationListResponse> list({
    String? cursor,
    int? limit,
    String? search,
  }) async {
    final res = await sendJson(
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
    final res = await sendJson(
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
    await sendJson(
      () => _dio.delete<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}',
      ),
    );
  }

  /// Renames a conversation. The title becomes the user's, so the server stops generating one.
  Future<ConversationListItem> rename(String id, String title) async {
    final res = await sendJson(
      () => _dio.patch<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}',
        data: {'title': title},
      ),
    );
    return ConversationListItem.fromJson(_asMap(_asMap(res.data)['conversation']));
  }

  /// Pins or unpins. Pinned rows ride the **first page only** — they are not a separate list, so
  /// a client must not try to page through them.
  Future<ConversationListItem> setPinned(String id, bool pinned) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}/${pinned ? 'pin' : 'unpin'}',
      ),
    );
    return ConversationListItem.fromJson(_asMap(_asMap(res.data)['conversation']));
  }

  /// Branches the conversation **at a user message** — a new conversation that replays your
  /// prompt down its own path. [entryId] is required: a fork without a point to fork from is a
  /// clone, and the server refuses it (`conversation_not_branchable`).
  Future<ConversationCreatedResponse> fork(String id, String entryId) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}/fork',
        data: {'entryId': entryId},
        options: longCall(),
      ),
    );
    return ConversationCreatedResponse.fromJson(_asMap(res.data));
  }

  /// Duplicates the whole conversation. No [entryId]: that is the difference from a fork.
  ///
  /// Refused with `conversation_not_branchable` on a conversation with no messages — there is
  /// genuinely nothing to duplicate, and the server says so rather than making an empty copy.
  Future<ConversationCreatedResponse> clone(String id) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}/clone',
        options: longCall(),
      ),
    );
    return ConversationCreatedResponse.fromJson(_asMap(res.data));
  }

  /// The `.nelle-chat.zip` bytes.
  ///
  /// **An `unavailable` conversation still exports** — you should be able to get your data out of
  /// a broken chat — and the archive records that its Pi session was already lost
  /// (`manifest.piSessionMissing`). Importing *that* archive is then refused. Both halves are the
  /// server's; the client only has to not hide either.
  Future<Uint8List> export(String id) => sendBytes(
    () => _dio.post<List<int>>(
      '/api/conversations/${Uri.encodeComponent(id)}/export',
      options: zipDownload(),
    ),
  );

  /// Imports a `.nelle-chat.zip`. **Always creates a new conversation** — it is never a merge, so
  /// importing the same archive twice gives you two chats.
  ///
  /// The bytes are the request **body**, not a multipart field (see [zipUpload]).
  Future<ConversationCreatedResponse> import(Uint8List bytes) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations/import',
        data: bytes,
        options: zipUpload(),
      ),
    );
    return ConversationCreatedResponse.fromJson(_asMap(res.data));
  }

  /// Why a conversation is `unavailable`, in the filesystem's own words.
  Future<ConversationDiagnostics> diagnostics(String id) async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}/diagnostics',
      ),
    );
    return ConversationDiagnostics.fromJson(
      _asMap(_asMap(res.data)['diagnostics']),
    );
  }

  /// Re-checks the Pi session file. **Succeeds only if the user put it back** — repair never
  /// invents a session, so a 409 here means the file is still gone and rebuild is the next choice.
  Future<ConversationSnapshot> repair(String id) => _snapshotAction(id, 'repair');

  /// Reconstructs the Pi session from the SQLite projection. **Lossy, and the UI must say so**:
  /// it drops tool results, image content, compaction summaries and regenerate variants. It is
  /// the last resort, not the first.
  Future<ConversationSnapshot> rebuild(String id) => _snapshotAction(id, 'rebuild');

  Future<ConversationSnapshot> _snapshotAction(String id, String action) async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/conversations/${Uri.encodeComponent(id)}/$action',
        options: longCall(),
      ),
    );
    return ConversationSnapshot.fromJson(_asMap(_asMap(res.data)['snapshot']));
  }

  Map<String, Object?> _asMap(Object? value) =>
      value is Map ? value.cast<String, Object?>() : const {};
}

final conversationsRepositoryProvider = Provider<ConversationsRepository>(
  (ref) => ConversationsRepository(ref.watch(dioProvider)),
);
