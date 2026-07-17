// A render object's mutable fields are private (public getter + a setter that
// `markNeedsLayout`/`markNeedsPaint`), so they can't use named initializing formals — the
// standard `_field = param` idiom trips `prefer_initializing_formals` with no way to satisfy it.
// ignore_for_file: prefer_initializing_formals
import 'dart:math' as math;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// Lays a message footer's sections out in a single **row with `·` separators** between them
/// when they fit within the available width, and stacks them on separate lines **without**
/// separators when they don't.
///
/// A `Wrap` cannot do this: a separator baked in as a child would still show after the wrap. So
/// this is a small custom layout — the same shape as Material's `OverflowBar` (row that becomes a
/// column when it doesn't fit), plus the conditional separators, which it paints itself (they are
/// not children, so hit-testing forwards cleanly to the real sections).
class FooterBar extends MultiChildRenderObjectWidget {
  const FooterBar({
    super.key,
    required super.children,
    required this.color,
    this.spacing = 8,
    this.runSpacing = 4,
  });

  /// Colour of the `·` separators (this widget inherits no text style).
  final Color color;

  /// Horizontal gap on each side of a separator, in row mode.
  final double spacing;

  /// Vertical gap between stacked sections, in column mode.
  final double runSpacing;

  @override
  RenderFooterBar createRenderObject(BuildContext context) => RenderFooterBar(
    color: color,
    spacing: spacing,
    runSpacing: runSpacing,
    textDirection: Directionality.of(context),
  );

  @override
  void updateRenderObject(BuildContext context, RenderFooterBar renderObject) {
    renderObject
      ..color = color
      ..spacing = spacing
      ..runSpacing = runSpacing
      ..textDirection = Directionality.of(context);
  }
}

class _FooterBarParentData extends ContainerBoxParentData<RenderBox> {}

class RenderFooterBar extends RenderBox
    with
        ContainerRenderObjectMixin<RenderBox, _FooterBarParentData>,
        RenderBoxContainerDefaultsMixin<RenderBox, _FooterBarParentData> {
  RenderFooterBar({
    required Color color,
    required double spacing,
    required double runSpacing,
    required TextDirection textDirection,
  }) : _color = color,
       _spacing = spacing,
       _runSpacing = runSpacing,
       _textDirection = textDirection;

  // A bullet, not a middle dot (`·`), and sized up: the middle dot read as too faint next to the
  // larger footer text.
  static const _separator = '•';
  static const _separatorStyle = TextStyle(fontSize: 13);

  Color _color;
  Color get color => _color;
  set color(Color value) {
    if (_color == value) return;
    _color = value;
    _rebuildSeparator();
    markNeedsPaint();
  }

  double _spacing;
  double get spacing => _spacing;
  set spacing(double value) {
    if (_spacing == value) return;
    _spacing = value;
    markNeedsLayout();
  }

  double _runSpacing;
  double get runSpacing => _runSpacing;
  set runSpacing(double value) {
    if (_runSpacing == value) return;
    _runSpacing = value;
    markNeedsLayout();
  }

  TextDirection _textDirection;
  TextDirection get textDirection => _textDirection;
  set textDirection(TextDirection value) {
    if (_textDirection == value) return;
    _textDirection = value;
    _rebuildSeparator();
    markNeedsLayout();
  }

  /// Whether the last layout placed the sections in one row (vs stacked). For tests.
  bool get isRow => _isRow;
  bool _isRow = true;

  late TextPainter _separatorPainter = _makeSeparatorPainter();
  TextPainter _makeSeparatorPainter() => TextPainter(
    text: TextSpan(text: _separator, style: _separatorStyle.copyWith(color: _color)),
    textDirection: _textDirection,
  )..layout();
  void _rebuildSeparator() => _separatorPainter = _makeSeparatorPainter();

  /// The width one separator occupies between two sections: the glyph plus a gap on each side.
  double get _separatorSlot => _separatorPainter.width + spacing * 2;

  @override
  void setupParentData(RenderBox child) {
    if (child.parentData is! _FooterBarParentData) {
      child.parentData = _FooterBarParentData();
    }
  }

  @override
  void performLayout() {
    final children = getChildrenAsList();
    if (children.isEmpty) {
      _isRow = true;
      size = constraints.smallest;
      return;
    }
    // Bounded (never unbounded): a section may itself hold a Flexible, which throws under an
    // unbounded width. Real footer sections are far narrower than the bubble, so this measures
    // their natural single-line size.
    final childConstraints = BoxConstraints(maxWidth: constraints.maxWidth);
    var rowWidth = 0.0;
    var rowHeight = 0.0;
    for (final child in children) {
      child.layout(childConstraints, parentUsesSize: true);
      rowWidth += child.size.width;
      rowHeight = math.max(rowHeight, child.size.height);
    }
    rowWidth += (children.length - 1) * _separatorSlot;

    if (rowWidth <= constraints.maxWidth) {
      _isRow = true;
      var x = 0.0;
      for (final child in children) {
        final data = child.parentData! as _FooterBarParentData;
        data.offset = Offset(x, (rowHeight - child.size.height) / 2);
        x += child.size.width + _separatorSlot;
      }
      size = constraints.constrain(Size(rowWidth, rowHeight));
      return;
    }

    // Doesn't fit: stack, no separators.
    _isRow = false;
    var y = 0.0;
    var maxWidth = 0.0;
    for (var i = 0; i < children.length; i++) {
      final child = children[i];
      final data = child.parentData! as _FooterBarParentData;
      data.offset = Offset(0, y);
      y += child.size.height;
      if (i < children.length - 1) y += runSpacing;
      maxWidth = math.max(maxWidth, child.size.width);
    }
    size = constraints.constrain(Size(maxWidth, y));
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    defaultPaint(context, offset);
    if (!_isRow) return;
    // A `·` centred vertically in each gap between adjacent sections.
    for (var child = firstChild; child != null;) {
      final data = child.parentData! as _FooterBarParentData;
      final next = data.nextSibling;
      if (next != null) {
        final dotX = offset.dx + data.offset.dx + child.size.width + spacing;
        final dotY = offset.dy + (size.height - _separatorPainter.height) / 2;
        _separatorPainter.paint(context.canvas, Offset(dotX, dotY));
      }
      child = next;
    }
  }

  @override
  bool hitTestChildren(BoxHitTestResult result, {required Offset position}) =>
      defaultHitTestChildren(result, position: position);

  @override
  double computeMinIntrinsicWidth(double height) {
    // Stacked, so the narrowest we can be is the widest single section.
    var widest = 0.0;
    for (var c = firstChild; c != null; c = childAfter(c)) {
      widest = math.max(widest, c.getMinIntrinsicWidth(height));
    }
    return widest;
  }

  @override
  double computeMaxIntrinsicWidth(double height) {
    // One row: every section plus the separators between them.
    var total = 0.0;
    var count = 0;
    for (var c = firstChild; c != null; c = childAfter(c)) {
      total += c.getMaxIntrinsicWidth(height);
      count++;
    }
    return count == 0 ? 0 : total + (count - 1) * _separatorSlot;
  }
}
