import 'package:flutter/material.dart';

import '../../api/generated/models/conversation_context_usage.dart';
import '../../api/generated/models/conversation_context_usage_status.dart';

/// Context-window usage bar. The server stamps `status`, so we pick a colour
/// rather than recomputing the ratio. When the window is unknown (no total) we
/// show the token count without a bar, per the server-vs-client contract.
class ContextBar extends StatelessWidget {
  const ContextBar({super.key, required this.usage});

  final ConversationContextUsage usage;

  @override
  Widget build(BuildContext context) {
    final used = usage.usedTokens;
    final total = usage.totalTokens;
    // Nothing measured yet (a fresh conversation): show nothing rather than a
    // bare "context" label.
    if (used == null && total == null) {
      return const SizedBox.shrink();
    }
    final ratio = (used != null && total != null && total > 0)
        ? (used / total).clamp(0.0, 1.0)
        : null;
    final color = switch (usage.status) {
      ConversationContextUsageStatus.overflow => Colors.red,
      ConversationContextUsageStatus.warning => Colors.orange,
      _ => Theme.of(context).colorScheme.primary,
    };
    final label = total != null
        ? '${_fmt(used)} / ${_fmt(total)} tokens'
        : used != null
        ? '${_fmt(used)} tokens'
        : 'context';

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
      child: Row(
        children: [
          if (ratio != null)
            Expanded(
              child: ClipRRect(
                borderRadius: BorderRadius.circular(3),
                child: LinearProgressIndicator(
                  value: ratio,
                  minHeight: 5,
                  color: color,
                  backgroundColor: color.withValues(alpha: 0.15),
                ),
              ),
            )
          else
            const Spacer(),
          const SizedBox(width: 10),
          Text(label, style: const TextStyle(fontSize: 11)),
        ],
      ),
    );
  }

  String _fmt(int? n) => n == null
      ? '—'
      : n >= 1000
      ? '${(n / 1000).toStringAsFixed(1)}k'
      : '$n';
}
