import 'package:flutter/widgets.dart';
import 'package:forui/forui.dart';

/// A collapsible **expandable card** — one forui `FAccordion` item inside an `FCard`.
///
/// Nelle's reasoning block and each tool-call card render through this, so they share one look
/// and only this file knows the forui engine (the way `MarkdownMessage` is the one place markdown
/// is rendered). If the card + accordion nesting ever reads as too heavy, this is the single file
/// to swap to a bare `FAccordion`.
class ExpandableCard extends StatelessWidget {
  const ExpandableCard({
    super.key,
    required this.title,
    required this.child,
    this.initiallyExpanded = false,
  });

  /// The always-visible header (the accordion supplies its own expand indicator).
  final Widget title;

  /// Revealed when expanded.
  final Widget child;

  final bool initiallyExpanded;

  @override
  Widget build(BuildContext context) => FCard.raw(
    // FCard.raw adds no padding and FAccordion's title/child padding is vertical-only, so the
    // header, chevron and content would sit flush against the card border. Inset the whole
    // accordion to give them horizontal breathing room.
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: FAccordion(
        children: [
          FAccordionItem(
            title: title,
            initiallyExpanded: initiallyExpanded,
            child: child,
          ),
        ],
      ),
    ),
  );
}
