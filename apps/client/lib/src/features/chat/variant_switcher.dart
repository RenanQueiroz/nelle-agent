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
        // Ghost icon buttons, xs to sit with the footer; a null `onPress` disables an end.
        FButton.icon(
          key: ValueKey('k-msg-variant-prev-$messageId'),
          size: FButtonSizeVariant.xs,
          variant: FButtonVariant.ghost,
          onPress: onPrev,
          child: const Icon(FLucideIcons.chevronLeft),
        ),
        Padding(
          key: ValueKey('k-msg-variant-label-$messageId'),
          padding: const EdgeInsets.symmetric(horizontal: 2),
          child: Text(
            '$current/$total',
            style: TextStyle(fontSize: 14, color: muted),
          ),
        ),
        FButton.icon(
          key: ValueKey('k-msg-variant-next-$messageId'),
          size: FButtonSizeVariant.xs,
          variant: FButtonVariant.ghost,
          onPress: onNext,
          child: const Icon(FLucideIcons.chevronRight),
        ),
      ],
    );
  }
}
