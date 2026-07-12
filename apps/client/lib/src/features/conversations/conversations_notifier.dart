import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/conversation_list_item.dart';
import 'conversations_repository.dart';

/// The loaded window of the conversation list plus its keyset cursor and the
/// full match `total` (which the UI shows, never the loaded count).
class ConversationsState {
  const ConversationsState({
    required this.items,
    required this.total,
    this.nextCursor,
    this.loadingMore = false,
  });

  final List<ConversationListItem> items;
  final int total;
  final String? nextCursor;
  final bool loadingMore;

  bool get hasMore => nextCursor != null;
  List<ConversationListItem> get pinned =>
      items.where((c) => c.pinned).toList();
  List<ConversationListItem> get recent =>
      items.where((c) => !c.pinned).toList();

  ConversationsState copyWith({
    List<ConversationListItem>? items,
    int? total,
    String? nextCursor,
    bool clearCursor = false,
    bool? loadingMore,
  }) => ConversationsState(
    items: items ?? this.items,
    total: total ?? this.total,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    loadingMore: loadingMore ?? this.loadingMore,
  );
}

/// Which conversation the workbench detail pane is showing. Client-local; the
/// chat feature reads it to load the snapshot.
final selectedConversationIdProvider = StateProvider<String?>((ref) => null);

final conversationsProvider =
    AsyncNotifierProvider<ConversationsNotifier, ConversationsState>(
      ConversationsNotifier.new,
    );

class ConversationsNotifier extends AsyncNotifier<ConversationsState> {
  ConversationsRepository get _repo =>
      ref.read(conversationsRepositoryProvider);

  @override
  Future<ConversationsState> build() async {
    final page = await _repo.list();
    return ConversationsState(
      items: page.conversations,
      total: page.total,
      nextCursor: page.nextCursor,
    );
  }

  Future<void> loadMore() async {
    final current = state.valueOrNull;
    if (current == null || !current.hasMore || current.loadingMore) {
      return;
    }
    state = AsyncData(current.copyWith(loadingMore: true));
    try {
      final page = await _repo.list(cursor: current.nextCursor);
      state = AsyncData(
        current.copyWith(
          items: [...current.items, ...page.conversations],
          total: page.total,
          nextCursor: page.nextCursor,
          clearCursor: page.nextCursor == null,
          loadingMore: false,
        ),
      );
    } catch (_) {
      state = AsyncData(current.copyWith(loadingMore: false));
      rethrow;
    }
  }

  /// Creates a conversation, prepends it optimistically, and returns it so the
  /// caller can select it.
  Future<ConversationListItem> createConversation() async {
    final created = await _repo.create();
    final current = state.valueOrNull;
    if (current != null) {
      state = AsyncData(
        current.copyWith(
          items: [created, ...current.items],
          total: current.total + 1,
        ),
      );
    } else {
      ref.invalidateSelf();
    }
    return created;
  }

  /// Removes a conversation optimistically, reloading the list if the delete
  /// fails so the row reappears.
  Future<void> deleteConversation(String id) async {
    final current = state.valueOrNull;
    if (current != null) {
      state = AsyncData(
        current.copyWith(
          items: current.items.where((c) => c.id != id).toList(),
          total: current.total > 0 ? current.total - 1 : 0,
        ),
      );
    }
    try {
      await _repo.delete(id);
    } catch (_) {
      ref.invalidateSelf();
      rethrow;
    }
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(build);
  }
}
