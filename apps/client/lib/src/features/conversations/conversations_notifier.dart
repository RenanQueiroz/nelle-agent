import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/generated/models/conversation_list_item.dart';
import '../../api/generated/models/conversation_list_item_title_source.dart';
import 'conversations_repository.dart';

/// The loaded window of the conversation list plus its keyset cursor and the
/// full match `total` (which the UI shows, never the loaded count).
class ConversationsState {
  const ConversationsState({
    required this.items,
    required this.total,
    this.nextCursor,
    this.loadingMore = false,
    this.search = '',
    this.searching = false,
    this.pendingDeletes = const {},
  });

  final List<ConversationListItem> items;

  /// Every conversation **matching the current search**, not the number loaded. The sidebar holds
  /// a *window* onto the list, so the loaded count is a fact about scrolling, not about the user's
  /// chats.
  final int total;
  final String? nextCursor;
  final bool loadingMore;

  /// The query the *server* is filtering by. Never a filter over the loaded page: filtering
  /// client-side would report "no matching chats" for every conversation the user has not
  /// scrolled far enough to load.
  final String search;

  /// A search is in flight. The list keeps showing the old results meanwhile -- blanking it makes
  /// the sidebar flicker on every keystroke.
  final bool searching;

  /// Deleted in the UI, not yet on the server: the request is held for [kDeleteUndoWindow] so it
  /// can be taken back. Hidden from every list, so a refresh landing in the window cannot
  /// resurrect a row the user just deleted.
  final Set<String> pendingDeletes;

  bool get hasMore => nextCursor != null;

  List<ConversationListItem> get _visible =>
      items.where((c) => !pendingDeletes.contains(c.id)).toList();

  List<ConversationListItem> get pinned =>
      _visible.where((c) => c.pinned).toList();
  List<ConversationListItem> get recent =>
      _visible.where((c) => !c.pinned).toList();

  /// Whether the list is empty *as the user sees it* -- which is not the same as having no items,
  /// because a search can match nothing.
  bool get isEmpty => _visible.isEmpty;

  /// The count to **show**.
  ///
  /// [total] is the server's, and during an undo window it is still counting a conversation the
  /// user has just deleted and can no longer see. Deleting the only match then left the header
  /// saying "Chats (1)" above the words "No chats match" -- which is not a rounding error, it is
  /// the header contradicting the list. The count must describe what is on screen.
  int get visibleTotal {
    final hidden = items.where((c) => pendingDeletes.contains(c.id)).length;
    final shown = total - hidden;
    return shown < 0 ? 0 : shown;
  }

  ConversationsState copyWith({
    List<ConversationListItem>? items,
    int? total,
    String? nextCursor,
    bool clearCursor = false,
    bool? loadingMore,
    String? search,
    bool? searching,
    Set<String>? pendingDeletes,
  }) => ConversationsState(
    items: items ?? this.items,
    total: total ?? this.total,
    nextCursor: clearCursor ? null : (nextCursor ?? this.nextCursor),
    loadingMore: loadingMore ?? this.loadingMore,
    search: search ?? this.search,
    searching: searching ?? this.searching,
    pendingDeletes: pendingDeletes ?? this.pendingDeletes,
  );
}

/// How long a delete can be taken back.
///
/// The delete is **held**, not undone: the request is not sent until the window closes, because
/// the server's delete is irreversible the moment it lands (it removes the Pi session file and any
/// attachment no other conversation references). Until then the row is simply hidden.
const kDeleteUndoWindow = Duration(seconds: 5);

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

  /// Held deletes, by conversation id. Each fires once its undo window closes.
  final Map<String, Timer> _deleteTimers = {};

  /// The newest search wins. Typing puts several requests in flight and they do not come back in
  /// order, so a slow early one landing last would show results for a query already typed past.
  int _searchToken = 0;

  @override
  Future<ConversationsState> build() async {
    ref.onDispose(() {
      // A held delete belongs to *this* list. If the connection changes -- a different server --
      // firing it later would delete a conversation on a machine the user never asked it to.
      for (final timer in _deleteTimers.values) {
        timer.cancel();
      }
      _deleteTimers.clear();
    });
    // **Watch**, not read. The repository is rebuilt whenever the connection changes,
    // and a connection change means a different *server*: pairing, disconnecting, or a
    // revoked device unpairing itself. Reading it here left the list showing whatever
    // it last saw -- on a phone, whose first launch cannot reach loopback at all, that
    // meant pairing succeeded and the user still stared at "Can't reach the server"
    // until they found the Retry button.
    final page = await ref.watch(conversationsRepositoryProvider).list();
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
      // The search rides along, or page two silently drops it and the user pages out of their
      // own search results.
      final page = await _repo.list(
        cursor: current.nextCursor,
        search: current.search,
      );
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

  /// Searches, on the **server**.
  ///
  /// The results replace the loaded window and reset the cursor, because a search is a different
  /// list: paging a search with the cursor from an unsearched list would walk the wrong rows.
  ///
  /// Guarded against its own races. Typing produces several of these in flight at once, and they
  /// do not come back in order -- a slow "n" landing after a fast "needle" would leave the list
  /// showing results for a query the user has finished typing past. Only the newest wins.
  Future<void> search(String query) async {
    final current = state.valueOrNull;
    final trimmed = query.trim();
    if (current == null || current.search == trimmed) {
      return;
    }
    final token = ++_searchToken;
    state = AsyncData(current.copyWith(search: trimmed, searching: true));
    try {
      final page = await _repo.list(search: trimmed);
      if (token != _searchToken) {
        return; // A newer search has been asked for; this answer is already stale.
      }
      state = AsyncData(
        (state.valueOrNull ?? current).copyWith(
          items: page.conversations,
          total: page.total,
          nextCursor: page.nextCursor,
          clearCursor: page.nextCursor == null,
          searching: false,
        ),
      );
    } catch (_) {
      if (token == _searchToken) {
        state = AsyncData(
          (state.valueOrNull ?? current).copyWith(searching: false),
        );
      }
      rethrow;
    }
  }

  /// Renames a conversation, and applies the row the server answers with.
  Future<void> rename(String id, String title) async {
    final updated = await _repo.rename(id, title.trim());
    _replace(updated);
  }

  /// Pins or unpins. The row moves between the sections on its own, because they are derived from
  /// `pinned` rather than held as two lists.
  Future<void> setPinned(String id, bool pinned) async {
    final updated = await _repo.setPinned(id, pinned);
    _replace(updated);
  }

  /// Puts a conversation that has just come into existence -- a clone, a fork, an import -- at the
  /// top of the list, where it belongs: it is the most recently touched thing there is.
  void addConversation(ConversationListItem conversation) {
    final current = state.valueOrNull;
    if (current == null) {
      ref.invalidateSelf();
      return;
    }
    state = AsyncData(
      current.copyWith(
        items: [conversation, ...current.items.where((c) => c.id != conversation.id)],
        total: current.total + 1,
      ),
    );
  }

  void _replace(ConversationListItem updated) {
    final current = state.valueOrNull;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        items: [
          for (final c in current.items) if (c.id == updated.id) updated else c,
        ],
      ),
    );
  }

  /// Applies a server-generated title to the matching row.
  ///
  /// The list is loaded once and then only mutated by explicit actions, so a title the server
  /// generates after the first exchange (streamed as `conversation.updated`, folded by the chat
  /// controller) never reached it — a fresh chat stayed "New chat" for the whole session. Only a
  /// row still on its **fallback** title is touched: that mirrors the server's own
  /// `setGeneratedTitle`, which refuses a conversation the user has renamed, so a rename the user
  /// has since made is never clobbered by a late title event.
  void applyGeneratedTitle(String id, String title) {
    final current = state.valueOrNull;
    if (current == null || title.isEmpty) return;
    final index = current.items.indexWhere(
      (c) =>
          c.id == id &&
          c.titleSource == ConversationListItemTitleSource.fallback &&
          c.title != title,
    );
    if (index < 0) return;
    final items = [...current.items];
    items[index] = _withGeneratedTitle(items[index], title);
    state = AsyncData(current.copyWith(items: items));
  }

  /// `ConversationListItem` is generated and has no `copyWith`, so rebuild it with the new title.
  ConversationListItem _withGeneratedTitle(ConversationListItem c, String title) =>
      ConversationListItem(
        id: c.id,
        title: title,
        titleSource: ConversationListItemTitleSource.generated,
        pinned: c.pinned,
        status: c.status,
        updatedAt: c.updatedAt,
        defaultModelId: c.defaultModelId,
      );

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

  /// Hides a conversation and **holds the delete** for [kDeleteUndoWindow].
  ///
  /// The request is not sent yet, and that is the point: the server's delete is irreversible the
  /// moment it lands -- it removes the Pi session file and every attachment no other conversation
  /// references -- so there is nothing to "undo" afterwards. It can only be *not done*. Until the
  /// window closes the row is simply hidden, and [undoDelete] cancels the whole thing.
  ///
  /// Before this, a single mis-tap on the trash icon destroyed a conversation with no
  /// confirmation and no way back.
  void deleteConversation(String id) {
    final current = state.valueOrNull;
    if (current == null || current.pendingDeletes.contains(id)) {
      return;
    }
    state = AsyncData(
      current.copyWith(pendingDeletes: {...current.pendingDeletes, id}),
    );
    _deleteTimers[id]?.cancel();
    _deleteTimers[id] = Timer(kDeleteUndoWindow, () => _commitDelete(id));
  }

  /// Takes back a delete that has not been sent yet.
  void undoDelete(String id) {
    final timer = _deleteTimers.remove(id);
    if (timer == null) return;
    timer.cancel();
    final current = state.valueOrNull;
    if (current == null) return;
    state = AsyncData(
      current.copyWith(
        pendingDeletes: {...current.pendingDeletes}..remove(id),
      ),
    );
  }

  Future<void> _commitDelete(String id) async {
    _deleteTimers.remove(id);
    try {
      await _repo.delete(id);
      final current = state.valueOrNull;
      if (current == null) return;
      state = AsyncData(
        current.copyWith(
          items: current.items.where((c) => c.id != id).toList(),
          total: current.total > 0 ? current.total - 1 : 0,
          pendingDeletes: {...current.pendingDeletes}..remove(id),
        ),
      );
    } catch (_) {
      // The row comes back, because it is still there. Silent: the user has moved on by now, and
      // a toast about a chat they deleted five seconds ago and cannot see is noise.
      ref.invalidateSelf();
    }
  }

  Future<void> refresh() async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(build);
  }
}
