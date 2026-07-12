import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../chat/chat_view.dart';
import '../conversations/conversation_list_panel.dart';
import '../conversations/conversations_notifier.dart';

/// Responsive workbench. Wide: two panes (list + chat). Narrow: the list, and
/// selecting a chat pushes the chat over it with a back affordance.
class WorkbenchScreen extends ConsumerWidget {
  const WorkbenchScreen({super.key});

  static const _twoPaneBreakpoint = 760.0;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedId = ref.watch(selectedConversationIdProvider);
    return FScaffold(
      childPad: false,
      child: LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth >= _twoPaneBreakpoint) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(width: 300, child: ConversationListPanel()),
                const VerticalDivider(width: 1),
                Expanded(
                  child: selectedId == null
                      ? const _EmptyDetail()
                      : ChatView(
                          key: ValueKey(selectedId),
                          conversationId: selectedId,
                        ),
                ),
              ],
            );
          }
          if (selectedId == null) {
            return const ConversationListPanel();
          }
          return ChatView(
            key: ValueKey(selectedId),
            conversationId: selectedId,
            onBack: () =>
                ref.read(selectedConversationIdProvider.notifier).state = null,
          );
        },
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
