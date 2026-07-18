import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/api_exception.dart';
import '../chat/chat_view.dart';
import '../conversations/conversation_list_panel.dart';
import '../conversations/conversations_notifier.dart';

/// The home screen, shaped like Claude's and ChatGPT's: the app opens **on a chat** —
/// the newest untouched one, else a fresh one — with the history a sidebar away.
///
/// Wide (≥760px): the conversation list rides `FScaffold`'s sidebar slot beside the
/// chat, and the chat header's top-left toggle collapses it for a focused view.
/// Narrow: the chat is the whole screen and the same toggle (a hamburger now) opens the
/// list as a left sheet — selecting there swaps the chat under it.
///
/// **The sheet is a pushed route, so widening the window has to take it down**
/// ([_dismissSheet]): a route does not care about layout, so a sheet opened while narrow
/// survived the crossing and sat on top of the persistent sidebar — two conversation
/// lists, one over the other.
class WorkbenchScreen extends ConsumerStatefulWidget {
  const WorkbenchScreen({super.key});

  static const _twoPaneBreakpoint = 760.0;

  @override
  ConsumerState<WorkbenchScreen> createState() => _WorkbenchScreenState();
}

class _WorkbenchScreenState extends ConsumerState<WorkbenchScreen> {
  bool _sidebarCollapsed = false;

  /// Lands the user in a fresh chat when nothing is selected — on first open, and again
  /// when a delete empties the selection. Deferred to a microtask because it mutates
  /// providers, and it may be noticed during build.
  void _ensureChat() {
    if (ref.read(selectedConversationIdProvider) != null) {
      return;
    }
    if (ref.read(conversationsProvider) is! AsyncData) {
      return; // Nothing to reuse yet — and nothing to create against, either.
    }
    unawaited(
      Future.microtask(() async {
        if (!mounted || ref.read(selectedConversationIdProvider) != null) {
          return;
        }
        try {
          await ref.read(conversationsProvider.notifier).openFreshChat();
        } catch (_) {
          // Creation failed (server unreachable): the pane already shows the list's
          // error with a retry, which is the actionable half of this failure.
        }
      }),
    );
  }

  /// The open sheet's own route, held so [_dismissSheet] can take down *that* route
  /// rather than popping whatever is on top — a rename dialog opened from a row menu
  /// inside the sheet sits above it, and a blind `pop()` would close the dialog and
  /// leave the sheet exactly where it was.
  ModalRoute<void>? _sheetRoute;

  void _openSheet() {
    if (_sheetRoute != null) {
      return; // Already open; a second hamburger tap must not stack a second sheet.
    }
    unawaited(
      showFSheet<void>(
        context: context,
        side: FLayout.ltr,
        // Unclamped: the default 9/16 ratio would cut the sidebar's 300px to ~226 on a
        // phone, ellipsizing the very titles the sheet exists to show.
        mainAxisMaxRatio: null,
        builder: (sheetContext) {
          // The route is only reachable from inside the builder; showFSheet hands back
          // a future, not the route it pushed.
          _sheetRoute = ModalRoute.of(sheetContext);
          return DecoratedBox(
            decoration: BoxDecoration(
              color: sheetContext.theme.colors.background,
            ),
            child: ConversationListPanel(
              onDestination: () => Navigator.of(sheetContext).pop(),
            ),
          );
        },
      ).whenComplete(() => _sheetRoute = null),
    );
  }

  /// Takes the sheet down because the window is now wide enough for the real sidebar.
  ///
  /// `removeRoute`, not `pop`: this is not the user dismissing a sheet, it is a layout
  /// change retiring one, so it should not animate out over a sidebar that is already
  /// there — and it must remove the sheet even when something else (a dialog) is above
  /// it.
  void _dismissSheet() {
    final route = _sheetRoute;
    _sheetRoute = null;
    if (route == null || !route.isActive) {
      return;
    }
    route.navigator?.removeRoute(route);
  }

  @override
  Widget build(BuildContext context) {
    final selectedId = ref.watch(selectedConversationIdProvider);
    final conversations = ref.watch(conversationsProvider);
    // Both watches above can invalidate the selection this frame; re-establish it after
    // the frame, never during it.
    _ensureChat();

    // MediaQuery, not LayoutBuilder: the sidebar is the *scaffold's* slot, so the
    // decision has to be made above the scaffold. Rebuilds on window resize.
    final wide =
        MediaQuery.sizeOf(context).width >= WorkbenchScreen._twoPaneBreakpoint;

    // The window just grew past the breakpoint with the sheet still up. Retire it after
    // the frame — navigation must never run during build — and honour what opening it
    // meant: the user asked for the conversation list, so the persistent sidebar takes
    // over rather than leaving them with neither.
    if (wide && _sheetRoute != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) {
          return;
        }
        _dismissSheet();
        if (_sidebarCollapsed) {
          setState(() => _sidebarCollapsed = false);
        }
      });
    }

    final pane = selectedId == null
        ? _HomePane(conversations: conversations)
        : ChatView(
            key: ValueKey(selectedId),
            conversationId: selectedId,
            onToggleSidebar: wide
                ? () => setState(() => _sidebarCollapsed = !_sidebarCollapsed)
                : _openSheet,
            sidebarIcon: wide ? FLucideIcons.panelLeft : FLucideIcons.menu,
          );

    return FScaffold(
      childPad: false,
      sidebar: wide && !_sidebarCollapsed ? const ConversationListPanel() : null,
      child: pane,
    );
  }
}

/// What the detail area shows while no chat is selected: the auto-open is normally a
/// frame away, so this is a spinner — unless the list itself failed, which is the one
/// case the user must act on.
class _HomePane extends ConsumerWidget {
  const _HomePane({required this.conversations});

  final AsyncValue<ConversationsState> conversations;

  @override
  Widget build(BuildContext context, WidgetRef ref) => switch (conversations) {
    AsyncError(:final error) => ConversationsErrorState(
      message: '$error',
      isCertificateMismatch:
          error is NelleApiException && error.code == 'certificate_mismatch',
      onRetry: () => ref.read(conversationsProvider.notifier).refresh(),
    ),
    _ => const Center(child: FCircularProgress.loader()),
  };
}
