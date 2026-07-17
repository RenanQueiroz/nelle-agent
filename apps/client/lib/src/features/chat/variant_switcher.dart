import 'package:flutter/widgets.dart';
import 'package:forui/forui.dart';

/// The message footer's `‹ N/M ›` variant pager.
///
/// One prompt can have several answers (each regenerate keeps the old one as a variant). This
/// shows the **active** one's position and pages to a sibling — which, on the server, becomes the
/// branch the conversation continues from. The arrows are null at the ends and while a run streams.
class VariantSwitcher extends StatelessWidget {
  const VariantSwitcher({
    super.key,
    required this.messageId,
    required this.current,
    required this.total,
    this.onPrev,
    this.onNext,
  });

  /// 1-based position of the active variant in its group.
  final int current;
  final int total;

  /// The active variant's message id — namespaces the arrow keys.
  final String messageId;

  final VoidCallback? onPrev;
  final VoidCallback? onNext;

  @override
  Widget build(BuildContext context) {
    final muted = context.theme.colors.mutedForeground;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _Arrow(
          arrowKey: ValueKey('k-msg-variant-prev-$messageId'),
          icon: FLucideIcons.chevronLeft,
          color: muted,
          onTap: onPrev,
        ),
        Padding(
          key: ValueKey('k-msg-variant-label-$messageId'),
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Text('$current/$total', style: TextStyle(fontSize: 14, color: muted)),
        ),
        _Arrow(
          arrowKey: ValueKey('k-msg-variant-next-$messageId'),
          icon: FLucideIcons.chevronRight,
          color: muted,
          onTap: onNext,
        ),
      ],
    );
  }
}

class _Arrow extends StatelessWidget {
  const _Arrow({
    required this.arrowKey,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  final Key arrowKey;
  final IconData icon;
  final Color color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => GestureDetector(
    key: arrowKey,
    behavior: HitTestBehavior.opaque,
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 2),
      // A disabled end reads as dimmer, not gone — the count still needs its brackets.
      child: Icon(
        icon,
        size: 16,
        color: onTap == null ? color.withValues(alpha: 0.35) : color,
      ),
    ),
  );
}
