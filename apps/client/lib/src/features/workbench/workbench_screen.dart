import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../chat/chat_view.dart';
import '../conversations/conversation_list_panel.dart';
import '../conversations/conversations_notifier.dart';

/// Responsive workbench. Wide: the conversation list rides `FScaffold`'s sidebar slot
/// (the same chassis as two-pane settings) beside the chat. Narrow: the list, and
/// selecting a chat pushes the chat over it with a back affordance.
class WorkbenchScreen extends ConsumerWidget {
  const WorkbenchScreen({super.key});

  static const _twoPaneBreakpoint = 760.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedId = ref.watch(selectedConversationIdProvider);
    // MediaQuery, not LayoutBuilder: the sidebar is the *scaffold's* slot, so the
    // decision has to be made above the scaffold. Rebuilds on window resize.
    final wide = MediaQuery.sizeOf(context).width >= _twoPaneBreakpoint;

    if (wide) {
      return FScaffold(
        childPad: false,
        // The end border is what FSidebar draws for itself in settings; the scaffold
        // slot paints only a background, and on a dark theme that is invisible.
        sidebar: DecoratedBox(
          decoration: BoxDecoration(
            border: BorderDirectional(
              end: BorderSide(color: context.theme.colors.border),
            ),
          ),
          child: const SizedBox(width: 300, child: ConversationListPanel()),
        ),
        child: selectedId == null
            ? const _EmptyDetail()
            : ChatView(key: ValueKey(selectedId), conversationId: selectedId),
      );
    }
    return FScaffold(
      childPad: false,
      child: selectedId == null
          ? const ConversationListPanel()
          : ChatView(
              key: ValueKey(selectedId),
              conversationId: selectedId,
              onBack: () =>
                  ref.read(selectedConversationIdProvider.notifier).state =
                      null,
            ),
    );
  }
}

class _EmptyDetail extends StatelessWidget {
  const _EmptyDetail();

  @override
  Widget build(BuildContext context) => Center(
    child: Text(
      'Select a chat',
      style: TextStyle(color: Theme.of(context).colorScheme.outline),
    ),
  );
}
