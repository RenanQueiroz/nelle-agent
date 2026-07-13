import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_exception.dart';
import '../../api/generated/models/conversation_list_item.dart';
import '../../api/generated/models/conversation_status.dart';
import 'conversations_notifier.dart';

/// The conversation sidebar: pinned + recent sections, new-chat, delete, and the
/// full match count in the header.
class ConversationListPanel extends ConsumerWidget {
  const ConversationListPanel({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final async = ref.watch(conversationsProvider);
    // What the user can *see*, not what the server still counts: a held delete is already gone
    // from the list, and a header that still counts it contradicts the rows beneath it.
    final total = async.valueOrNull?.visibleTotal;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FHeader(
          title: Text(total == null ? 'Chats' : 'Chats ($total)'),
          suffixes: [
            FHeaderAction(
              key: const ValueKey('k-conv-new'),
              icon: const Icon(FLucideIcons.squarePen),
              onPress: () => _newChat(context, ref),
            ),
            FHeaderAction(
              key: const ValueKey('k-conv-settings'),
              icon: const Icon(FLucideIcons.settings),
              // Push, so there is something to pop back to. `go()` replaces the stack.
              onPress: () => context.push('/settings'),
            ),
          ],
        ),
        const _SearchBox(),
        Expanded(
          child: switch (async) {
            AsyncData(:final value) => _ConversationList(state: value),
            AsyncError(:final error) => _ErrorState(
              message: '$error',
              // A rejected certificate is not a network fault, and must not look like
              // one: the glanceable signal is what a user actually reads.
              isCertificateMismatch:
                  error is NelleApiException &&
                  error.code == 'certificate_mismatch',
              onRetry: () => ref.read(conversationsProvider.notifier).refresh(),
            ),
            _ => const Center(child: CircularProgressIndicator()),
          },
        ),
      ],
    );
  }

  Future<void> _newChat(BuildContext context, WidgetRef ref) async {
    try {
      final created = await ref
          .read(conversationsProvider.notifier)
          .createConversation();
      ref.read(selectedConversationIdProvider.notifier).state = created.id;
    } catch (e) {
      if (context.mounted) _toastError(context, 'Could not create chat: $e');
    }
  }
}

/// Searches on the **server**, on a debounce.
///
/// Never a filter over the loaded page. The sidebar holds a *window* onto the conversation list,
/// so filtering what happens to be loaded would report "no matching chats" for every conversation
/// the user has not scrolled far enough to see -- which is most of them.
///
/// The debounce is not cosmetic: without it every keystroke is a round trip, and the answers come
/// back out of order. (The notifier guards that race as well, because a debounce narrows the
/// window and does not close it.)
class _SearchBox extends ConsumerStatefulWidget {
  const _SearchBox();

  @override
  ConsumerState<_SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends ConsumerState<_SearchBox> {
  final _controller = TextEditingController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    // forui's `FTextField` takes no `onChange`: the controller *is* the change channel.
    _controller.addListener(_onChanged);
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.removeListener(_onChanged);
    _controller.dispose();
    super.dispose();
  }

  void _onChanged() {
    final query = _controller.text;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () {
      // A failed search leaves the previous results on screen. The list is not *wrong* then, only
      // un-narrowed, and blanking it would be worse than doing nothing.
      unawaited(
        ref.read(conversationsProvider.notifier).search(query).catchError((_) {}),
      );
    });
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
    child: FTextField(
      key: const ValueKey('k-conv-search'),
      control: FTextFieldControl.managed(controller: _controller),
      hint: 'Search chats',
    ),
  );
}

class _ConversationList extends ConsumerWidget {
  const _ConversationList({required this.state});

  final ConversationsState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.isEmpty) {
      // "No chats yet" is a lie when a search simply matched nothing -- it says the user has no
      // conversations, when what happened is that this word does not appear in any of them.
      final searching = state.search.isNotEmpty;
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            searching ? 'No chats match “${state.search}”.' : 'No chats yet.',
            key: ValueKey(searching ? 'k-conv-no-matches' : 'k-conv-empty'),
            textAlign: TextAlign.center,
          ),
        ),
      );
    }
    final selectedId = ref.watch(selectedConversationIdProvider);
    return ListView(
      padding: const EdgeInsets.symmetric(vertical: 8),
      children: [
        if (state.pinned.isNotEmpty) ...[
          const _SectionLabel('Pinned'),
          FTileGroup(
            children: [
              for (final c in state.pinned) _tile(context, ref, c, selectedId),
            ],
          ),
          const SizedBox(height: 12),
        ],
        if (state.recent.isNotEmpty) ...[
          const _SectionLabel('Recent'),
          FTileGroup(
            children: [
              for (final c in state.recent) _tile(context, ref, c, selectedId),
            ],
          ),
        ],
        if (state.hasMore)
          Padding(
            padding: const EdgeInsets.all(8),
            child: FButton(
              key: const ValueKey('k-conv-load-more'),
              onPress: state.loadingMore
                  ? null
                  : () => ref.read(conversationsProvider.notifier).loadMore(),
              child: Text(state.loadingMore ? 'Loading…' : 'Load more'),
            ),
          ),
      ],
    );
  }

  FTile _tile(
    BuildContext context,
    WidgetRef ref,
    ConversationListItem c,
    String? selectedId,
  ) {
    final status = _statusLabel(c.status);
    return FTile(
      key: ValueKey('k-conv-tile-${c.id}'),
      title: Text(
        c.title.isEmpty ? 'Untitled' : c.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: status == null ? null : Text(status),
      selected: c.id == selectedId,
      onPress: () =>
          ref.read(selectedConversationIdProvider.notifier).state = c.id,
      suffix: _RowMenu(conversation: c),
    );
  }
}

/// Rename, pin, delete — and, from T4/T5, duplicate and export.
///
/// A menu rather than a row of icons: a phone has no room for four, and `apps/web` learned the
/// same thing. The trash icon it replaces was a **one-tap, unconfirmed, irreversible delete**.
class _RowMenu extends ConsumerStatefulWidget {
  const _RowMenu({required this.conversation});

  final ConversationListItem conversation;

  @override
  ConsumerState<_RowMenu> createState() => _RowMenuState();
}

class _RowMenuState extends ConsumerState<_RowMenu>
    with SingleTickerProviderStateMixin {
  late final FPopoverController _popover = FPopoverController(vsync: this);

  @override
  void dispose() {
    _popover.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.conversation;
    return FPopoverMenu(
      control: FPopoverControl.managed(controller: _popover),
      menuAnchor: Alignment.topRight,
      childAnchor: Alignment.bottomRight,
      menu: [
        FItemGroup(
          children: [
            FItem(
              key: ValueKey('k-conv-rename-${c.id}'),
              title: const Text('Rename'),
              prefix: const Icon(FLucideIcons.pencil),
              onPress: () {
                _popover.hide();
                _rename(context, ref, c);
              },
            ),
            FItem(
              key: ValueKey('k-conv-pin-${c.id}'),
              title: Text(c.pinned ? 'Unpin' : 'Pin'),
              prefix: Icon(c.pinned ? FLucideIcons.pinOff : FLucideIcons.pin),
              onPress: () {
                _popover.hide();
                _setPinned(context, ref, c);
              },
            ),
            FItem(
              key: ValueKey('k-conv-delete-${c.id}'),
              title: const Text('Delete'),
              prefix: const Icon(FLucideIcons.trash2),
              onPress: () {
                _popover.hide();
                _delete(context, ref, c);
              },
            ),
          ],
        ),
      ],
      builder: (context, controller, child) => FButton.icon(
        key: ValueKey('k-conv-menu-${c.id}'),
        onPress: controller.toggle,
        child: const Icon(FLucideIcons.ellipsis, size: 16),
      ),
    );
  }

  Future<void> _rename(
    BuildContext context,
    WidgetRef ref,
    ConversationListItem c,
  ) async {
    final title = await showRenameDialog(context, c.title);
    if (title == null || !context.mounted) return;
    try {
      await ref.read(conversationsProvider.notifier).rename(c.id, title);
    } catch (e) {
      if (context.mounted) _toastError(context, 'Rename failed: $e');
    }
  }

  Future<void> _setPinned(
    BuildContext context,
    WidgetRef ref,
    ConversationListItem c,
  ) async {
    try {
      await ref
          .read(conversationsProvider.notifier)
          .setPinned(c.id, !c.pinned);
    } catch (e) {
      if (context.mounted) {
        _toastError(context, '${c.pinned ? 'Unpin' : 'Pin'} failed: $e');
      }
    }
  }

  /// Hides the row and **holds** the delete for five seconds.
  ///
  /// There is no confirmation dialog, deliberately: a dialog on every delete taxes the ninety-nine
  /// deliberate ones to catch the one mistake. The undo does the same job and costs nothing --
  /// and it is a *held request*, not a reversal, because the server's delete cannot be reversed
  /// (it removes the Pi session file and any attachment nothing else references).
  void _delete(BuildContext context, WidgetRef ref, ConversationListItem c) {
    final notifier = ref.read(conversationsProvider.notifier);
    final wasSelected = ref.read(selectedConversationIdProvider) == c.id;
    notifier.deleteConversation(c.id);
    if (wasSelected) {
      ref.read(selectedConversationIdProvider.notifier).state = null;
    }
    showFToast(
      context: context,
      icon: const Icon(FLucideIcons.trash2),
      title: Text('Deleted “${c.title.isEmpty ? 'Untitled' : c.title}”'),
      suffixBuilder: (context, entry) => FButton(
        key: ValueKey('k-conv-undo-${c.id}'),
        variant: FButtonVariant.outline,
        onPress: () {
          notifier.undoDelete(c.id);
          if (wasSelected) {
            ref.read(selectedConversationIdProvider.notifier).state = c.id;
          }
          entry.dismiss();
        },
        child: const Text('Undo'),
      ),
      duration: kDeleteUndoWindow,
    );
  }
}

/// Asks for a new title. `null` means the user backed out — which is not the same as an empty
/// title, and must not rename the chat to nothing.
Future<String?> showRenameDialog(BuildContext context, String current) =>
    showFDialog<String>(
      context: context,
      builder: (context, style, animation) => _RenameDialog(
        style: style,
        animation: animation,
        current: current,
      ),
    );

/// Stateful **so that it owns the controller**, which is the whole point.
///
/// The obvious version -- `showFDialog(...).whenComplete(controller.dispose)` -- disposes the
/// controller the moment `Navigator.pop` is called, while the dialog is still *animating out*.
/// Its `FTextField` keeps rebuilding against it for those few frames, throws "A
/// TextEditingController was used after being disposed", and takes the entire app down to a red
/// screen. `flutter analyze` was clean and every widget test passed; it took one rename in the
/// running app to find.
///
/// A `State`'s `dispose()` runs when the element is actually unmounted, which is after the
/// animation, which is the only time this is safe.
class _RenameDialog extends StatefulWidget {
  const _RenameDialog({
    required this.style,
    required this.animation,
    required this.current,
  });

  final FDialogStyle style;
  final Animation<double> animation;
  final String current;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.current,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _save() {
    final title = _controller.text.trim();
    // An empty title is not a rename. The server refuses it anyway (`min(1)`), and quietly doing
    // nothing is friendlier than showing the user a 400 for pressing Save on an empty box.
    Navigator.of(context).pop(title.isEmpty ? null : title);
  }

  @override
  Widget build(BuildContext context) => FDialog(
    style: widget.style,
    animation: widget.animation,
    direction: Axis.horizontal,
    title: const Text('Rename chat'),
    body: FTextField(
      key: const ValueKey('k-conv-rename-field'),
      control: FTextFieldControl.managed(controller: _controller),
      autofocus: true,
      onSubmit: (_) => _save(),
    ),
    actions: [
      FButton(
        key: const ValueKey('k-conv-rename-cancel'),
        variant: FButtonVariant.outline,
        onPress: () => Navigator.of(context).pop(),
        child: const Text('Cancel'),
      ),
      FButton(
        key: const ValueKey('k-conv-rename-save'),
        onPress: _save,
        child: const Text('Save'),
      ),
    ],
  );
}

String? _statusLabel(ConversationStatus status) => switch (status) {
  ConversationStatus.running => 'Running…',
  ConversationStatus.compacting => 'Compacting…',
  ConversationStatus.aborting => 'Stopping…',
  ConversationStatus.unavailable => 'Unavailable',
  _ => null,
};

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        letterSpacing: 0.4,
      ),
    ),
  );
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({
    required this.message,
    required this.onRetry,
    this.isCertificateMismatch = false,
  });

  final String message;
  final VoidCallback onRetry;

  /// The server answered, and we refused to trust it. That is the opposite of
  /// unreachable, and a wifi-off icon over "Can't reach the server" sends the user to
  /// check their network -- which is the one thing that is definitely not wrong.
  final bool isCertificateMismatch;

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            isCertificateMismatch
                ? FLucideIcons.shieldAlert
                : FLucideIcons.wifiOff,
            size: 32,
            color: isCertificateMismatch
                ? Theme.of(context).colorScheme.error
                : null,
          ),
          const SizedBox(height: 12),
          Text(
            isCertificateMismatch
                ? 'This is not the server you paired with'
                : 'Can’t reach the server',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            maxLines: 4,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 12),
          FButton(
            key: const ValueKey('k-conv-retry'),
            onPress: onRetry,
            child: const Text('Retry'),
          ),
        ],
      ),
    ),
  );
}

void _toastError(BuildContext context, String message) {
  showFToast(
    context: context,
    icon: const Icon(FLucideIcons.circleX),
    title: Text(message),
  );
}
