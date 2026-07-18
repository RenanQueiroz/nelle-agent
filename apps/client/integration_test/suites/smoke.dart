import 'package:flutter_test/flutter_test.dart';

import '../helpers/device_harness.dart';

/// The first device test, and the one that proves the harness.
///
/// It asserts almost nothing about the app and everything about the arrangement: that the real
/// `main()` boots on a real device, reaches a real Nelle server over real HTTP, and renders what
/// that server actually has. Every other test in the suite is built on those four things being
/// true at once, and none of them is true in a widget test.
void smokeSuite() {
  testWidgets('the real app reaches the real server and renders its conversations', (
    tester,
  ) async {
    await launchApp(tester);
    await ensureChatsVisible(tester);

    // The fixture seeded exactly three. If this fails the server is not the one we think it is --
    // most likely the developer's, on 8787, which is the mistake the whole harness exists to make
    // impossible.
    expect(find.text(Fixture.withHistory), findsOneWidget);
    expect(find.text(Fixture.aboutPelicans), findsOneWidget);
    expect(find.text(Fixture.empty), findsOneWidget);

    // ...and the section heading counts what the *server* says, not the rows on screen (50 --
    // the list pages at 50, which is what makes the search test mean anything). 65 seeded, plus
    // the fresh "New chat" the home auto-opened on first launch and adopts on every launch after.
    expect(find.textContaining('RECENT (66)'), findsOneWidget);
  });

  testWidgets('opening a conversation loads its real history', (tester) async {
    await launchApp(tester);
    await ensureChatsVisible(tester);

    await tapAt(tester, find.text(Fixture.withHistory));
    final userTurn = find.textContaining(
      'Tell me about ${Fixture.withHistory}',
    );
    await pumpUntil(tester, userTurn);

    // The Pi session the fixture seeded, read back through the snapshot route. A widget test can
    // only ever assert that the client renders a canned JSON blob correctly; this asserts that the
    // server can actually produce it.
    expect(userTurn, findsOneWidget);
    expect(
      find.textContaining('Here is what I know about ${Fixture.withHistory}'),
      findsOneWidget,
    );
  });
}
