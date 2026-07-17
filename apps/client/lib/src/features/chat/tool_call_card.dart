import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/tool_call_event.dart';
import '../../api/generated/models/tool_call_event_status.dart';
import 'expandable_card.dart';

/// A settled message's `toolCalls` (raw JSON on `ConversationMessage`, typed `dynamic`) parsed
/// into a typed list. Junk is skipped, never a crash — same posture as `parseMessagePerformance`.
List<ToolCallEvent> parseToolCalls(Object? raw) {
  if (raw is! List) {
    return const [];
  }
  final calls = <ToolCallEvent>[];
  for (final item in raw) {
    if (item is Map) {
      try {
        calls.add(ToolCallEvent.fromJson(item.cast<String, Object?>()));
      } catch (_) {
        // A malformed tool call is dropped, not fatal.
      }
    }
  }
  return calls;
}

/// Upserts [call] into [calls] by id — a call moves running → complete/error over several
/// `tool_call.updated` events, and each replaces the prior state in place (keeping order).
List<ToolCallEvent> upsertToolCall(List<ToolCallEvent> calls, ToolCallEvent call) {
  final index = calls.indexWhere((c) => c.id == call.id);
  if (index < 0) {
    return [...calls, call];
  }
  final next = [...calls];
  next[index] = call;
  return next;
}

/// One tool call, rendered as an expandable card: the header names the tool and shows its status;
/// expanding reveals the input and output. Correlated by id, so a running call becomes a complete
/// one in place.
class ToolCallCard extends StatelessWidget {
  const ToolCallCard({super.key, required this.call});

  final ToolCallEvent call;

  @override
  Widget build(BuildContext context) {
    final muted = context.theme.colors.mutedForeground;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: ExpandableCard(
        key: ValueKey('k-msg-toolcall-${call.id}'),
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _StatusIcon(status: call.status),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                call.name,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w500,
                  color: muted,
                ),
              ),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (call.input != null && call.input!.isNotEmpty)
              _MonoBlock(label: 'Input', text: call.input!),
            if (call.output != null && call.output!.isNotEmpty)
              _MonoBlock(label: 'Output', text: call.output!),
          ],
        ),
      ),
    );
  }
}

/// The tool call's status: running / complete / error. A static icon rather than a Material
/// spinner — this app has no `Material` ancestor.
class _StatusIcon extends StatelessWidget {
  const _StatusIcon({required this.status});

  final ToolCallEventStatus status;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (icon, color) = switch (status) {
      ToolCallEventStatus.complete => (FLucideIcons.check, scheme.primary),
      ToolCallEventStatus.error => (FLucideIcons.circleAlert, scheme.error),
      // running, and any status a newer server invents, read as "in progress".
      _ => (FLucideIcons.loaderCircle, context.theme.colors.mutedForeground),
    };
    return Icon(icon, size: 15, color: color);
  }
}

/// A labelled monospace block for a tool call's input or output.
class _MonoBlock extends StatelessWidget {
  const _MonoBlock({required this.label, required this.text});

  final String label;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final muted = context.theme.colors.mutedForeground;
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(label, style: TextStyle(fontSize: 11, color: muted)),
          const SizedBox(height: 2),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(6),
            ),
            child: SelectableText(
              text,
              style: const TextStyle(
                fontFamily: 'monospace',
                fontFamilyFallback: ['Menlo', 'Consolas', 'DejaVu Sans Mono'],
                fontSize: 12,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
