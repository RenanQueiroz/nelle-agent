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

  void _openSheet() {
    unawaited(
      showFSheet(
        context: context,
        side: FLayout.ltr,
        // Unclamped: the default 9/16 ratio would cut the sidebar's 300px to ~226 on a
        // phone, ellipsizing the very titles the sheet exists to show.
        mainAxisMaxRatio: null,
        builder: (sheetContext) => DecoratedBox(
          decoration: BoxDecoration(
            color: sheetContext.theme.colors.background,
          ),
          child: ConversationListPanel(
            onDestination: () => Navigator.of(sheetContext).pop(),
          ),
        ),
      ),
    );
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
