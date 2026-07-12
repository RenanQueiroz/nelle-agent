import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../conversations/conversation_list_panel.dart';
import '../conversations/conversations_notifier.dart';

/// The main two-pane workbench: conversation list on the left, the selected
/// conversation on the right. The detail pane is a placeholder until the chat
/// view lands.
class WorkbenchScreen extends ConsumerWidget {
  const WorkbenchScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final selectedId = ref.watch(selectedConversationIdProvider);
    return FScaffold(
      childPad: false,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(width: 300, child: ConversationListPanel()),
          const VerticalDivider(width: 1),
          Expanded(
            child: Center(
              child: Text(
                selectedId == null
                    ? 'Select a chat'
                    : 'Chat pane — coming next\n($selectedId)',
                textAlign: TextAlign.center,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
