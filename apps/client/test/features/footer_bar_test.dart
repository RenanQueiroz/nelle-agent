import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/chat/footer_bar.dart';

Widget _host(double maxWidth, List<Widget> children) => Directionality(
  textDirection: TextDirection.ltr,
  child: Align(
    alignment: Alignment.topLeft,
    child: ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth),
      child: FooterBar(color: const Color(0xFF888888), children: children),
    ),
  ),
);

Widget _box(String key, double width) =>
    SizedBox(key: ValueKey(key), width: width, height: 20);

RenderFooterBar _render(WidgetTester tester) =>
    tester.renderObject<RenderFooterBar>(find.byType(FooterBar));

Offset _at(WidgetTester tester, String key) =>
    tester.getTopLeft(find.byKey(ValueKey(key)));

void main() {
  testWidgets('sections sit in one row with gaps when they fit', (tester) async {
    await tester.pumpWidget(
      _host(600, [_box('a', 100), _box('b', 100), _box('c', 100)]),
    );

    expect(_render(tester).isRow, isTrue);
    final a = _at(tester, 'a');
    final b = _at(tester, 'b');
    final c = _at(tester, 'c');
    // Horizontal: same top, strictly increasing left.
    expect(a.dy, b.dy);
    expect(b.dy, c.dy);
    expect(a.dx, lessThan(b.dx));
    expect(b.dx, lessThan(c.dx));
    // The gap exceeds the section width, so there is room for a `·` separator between them.
    expect(b.dx - a.dx, greaterThan(100));
    expect(tester.takeException(), isNull);
  });

  testWidgets('sections stack, without separators, when they do not fit', (
    tester,
  ) async {
    // Three 100-wide sections plus separators need ~340px; 200 forces a column.
    await tester.pumpWidget(
      _host(200, [_box('a', 100), _box('b', 100), _box('c', 100)]),
    );

    expect(_render(tester).isRow, isFalse);
    final a = _at(tester, 'a');
    final b = _at(tester, 'b');
    final c = _at(tester, 'c');
    // Vertical: same left, strictly increasing top — and each row is exactly the section
    // width apart (no separator slot eating into the run).
    expect(a.dx, 0);
    expect(b.dx, 0);
    expect(c.dx, 0);
    expect(a.dy, lessThan(b.dy));
    expect(b.dy, lessThan(c.dy));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a single section is a row and never needs a separator', (
    tester,
  ) async {
    await tester.pumpWidget(_host(200, [_box('only', 100)]));

    expect(_render(tester).isRow, isTrue);
    expect(_at(tester, 'only'), const Offset(0, 0));
    expect(tester.takeException(), isNull);
  });

  testWidgets('the crossover happens at the available width', (tester) async {
    // Two 100-wide sections + one separator slot (~19px) ≈ 219px.
    await tester.pumpWidget(_host(300, [_box('a', 100), _box('b', 100)]));
    expect(_render(tester).isRow, isTrue);

    await tester.pumpWidget(_host(150, [_box('a', 100), _box('b', 100)]));
    expect(_render(tester).isRow, isFalse);
    expect(tester.takeException(), isNull);
  });
}
