import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/features/chat/expandable_card.dart';

Widget _host(Widget child) => MaterialApp(
  home: FTheme(
    data: FThemes.neutral.light.desktop,
    child: FScaffold(child: child),
  ),
);

void main() {
  testWidgets('is collapsed by default and reveals its child on tap', (
    tester,
  ) async {
    await tester.pumpWidget(
      _host(
        const ExpandableCard(
          title: Text('Details'),
          child: Text('the hidden content'),
        ),
      ),
    );

    expect(find.text('Details'), findsOneWidget);
    // forui's FAccordion keeps the collapsed child in the tree but clips it, so it is present
    // yet not hit-testable until expanded.
    expect(find.text('the hidden content').hitTestable(), findsNothing);

    await tester.tap(find.text('Details'));
    await tester.pumpAndSettle();

    expect(find.text('the hidden content').hitTestable(), findsOneWidget);
  });

  testWidgets('initiallyExpanded shows its child straight away', (tester) async {
    await tester.pumpWidget(
      _host(
        const ExpandableCard(
          title: Text('Details'),
          initiallyExpanded: true,
          child: Text('shown'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('shown').hitTestable(), findsOneWidget);
  });
}
