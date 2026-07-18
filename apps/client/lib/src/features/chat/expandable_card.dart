import 'package:flutter/widgets.dart';
import 'package:forui/forui.dart';

/// A collapsible **expandable card** — a custom header over forui's primitive
/// `FCollapsible`, inside an `FCard`.
///
/// Nelle's reasoning block and each tool-call card render through this, so they share one look
/// and only this file knows the collapse engine (the way `MarkdownMessage` is the one place
/// markdown is rendered). It was an `FAccordion` once; the primitive buys what the accordion
/// withheld: the card can be opened and closed *programmatically* ([open]), which is how the
/// streaming reasoning card shows the thoughts while they arrive and puts them away when the
/// answer starts.
class ExpandableCard extends StatefulWidget {
  const ExpandableCard({
    super.key,
    required this.title,
    required this.child,
    this.initiallyExpanded = false,
    this.open,
  });

  /// The always-visible header row (the card supplies its own trailing chevron).
  final Widget title;

  /// Revealed when expanded.
  final Widget child;

  final bool initiallyExpanded;

  /// When non-null, the card follows this value whenever it **changes** — never on a
  /// rebuild that repeats it, so the user's own taps are not fought: collapsing a card
  /// mid-stream sticks until the stream itself transitions.
  final bool? open;

  @override
  State<ExpandableCard> createState() => _ExpandableCardState();
}

class _ExpandableCardState extends State<ExpandableCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    duration: const Duration(milliseconds: 220),
    vsync: this,
    value: (widget.open ?? widget.initiallyExpanded) ? 1 : 0,
  );
  late final CurvedAnimation _animation = CurvedAnimation(
    parent: _controller,
    curve: Curves.easeInOut,
  );

  @override
  void didUpdateWidget(covariant ExpandableCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    final open = widget.open;
    if (open != null && open != oldWidget.open) {
      open ? _controller.forward() : _controller.reverse();
    }
  }

  @override
  void dispose() {
    _animation.dispose();
    _controller.dispose();
    super.dispose();
  }

  void _toggle() {
    final opening =
        _controller.status == AnimationStatus.forward ||
        _controller.status == AnimationStatus.completed;
    opening ? _controller.reverse() : _controller.forward();
  }

  @override
  Widget build(BuildContext context) => FCard.raw(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FTappable(
          onPress: _toggle,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: Row(
              children: [
                Expanded(child: widget.title),
                RotationTransition(
                  turns: Tween(begin: 0.0, end: 0.5).animate(_animation),
                  child: Icon(
                    FLucideIcons.chevronDown,
                    size: 15,
                    color: context.theme.colors.mutedForeground,
                  ),
                ),
              ],
            ),
          ),
        ),
        // The child stays in the tree while collapsed (FCollapsible clips it to
        // height × value), so expanding never re-runs markdown layout from scratch.
        AnimatedBuilder(
          animation: _animation,
          builder: (context, child) =>
              FCollapsible(value: _animation.value, child: child!),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
            child: widget.child,
          ),
        ),
      ],
    ),
  );
}
