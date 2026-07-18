import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/device_harness.dart';

/// The M8 conversation lifecycle, against a **real server**.
///
/// The widget tests for all of this stub dio: they prove the client sends the right request and
/// renders the right response. They cannot prove the server *answers* that way, that the two halves
/// agree, or that any of it survives a real frame budget on a real device. This does.
void lifecycleSuite() {
  testWidgets('search finds a chat that is not on the loaded page', (
    tester,
  ) async {
    // **The one that proves search is a server query.** The fixture seeds 65 conversations; the
    // list pages at 50, and the needle is the oldest, so it is *not* among the rows the client has.
    // A client-side filter over what happens to be loaded would report "no matching chats" — which
    // is precisely the bug the rule exists to prevent.
    await launchApp(tester);

    expect(
      find.text(Fixture.needle),
      findsNothing,
      reason:
          'the needle must not be on the first page, or this test proves nothing',
    );

    await typeInto(
      tester,
      find.byKey(const ValueKey('k-conv-search')),
      'Xylophone',
    );
    // Pumping advances the debounce; presence proves the real HTTP response also landed.
    await pumpUntil(tester, find.text(Fixture.needle));

    expect(find.text(Fixture.needle), findsOneWidget);
    // The header counts every MATCH, not the rows on screen.
    expect(find.textContaining('Chats (1)'), findsOneWidget);
  });

  testWidgets('renaming a chat does not crash the app', (tester) async {
    // M8 T3 found this by driving: `showFDialog(...).whenComplete(controller.dispose)` destroys the
    // `TextEditingController` while the dialog is still animating out, and the whole app goes to a
    // red screen. `flutter analyze` was clean and 283 widget tests passed. This is where that class
    // of bug is caught from now on.
    //
    // It brings its own conversation: every test drives the same server, in order, so renaming a
    // *seeded* one breaks the next test that looks for it by name. (Which is what happened the
    // first time this suite ran.)
    final chat = await createOwnConversation('the rename test');
    await launchApp(tester);

    final id = chat.id;
    await tester.tap(find.byKey(ValueKey('k-conv-menu-$id')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('k-conv-rename-$id')));
    await tester.pumpAndSettle();

    await typeInto(
      tester,
      find.byKey(const ValueKey('k-conv-rename-field')),
      'Renamed without crashing',
    );
    await tester.tap(find.byKey(const ValueKey('k-conv-rename-save')));

    // Scope the success barrier to the conversation tile. A bare `find.text` also matches the
    // rename field while its dialog is animating out, so it can return before the PATCH response
    // lands; that passed locally and failed on the slower iOS CI runner one line later.
    final renamedTitle = find.descendant(
      of: find.byKey(ValueKey('k-conv-tile-$id')),
      matching: find.text('Renamed without crashing'),
    );
    await pumpUntil(tester, renamedTitle);

    expect(tester.takeException(), isNull);
    expect(renamedTitle, findsOneWidget);
  });

  testWidgets('duplicating an EMPTY chat is refused with the server sentence', (
    tester,
  ) async {
    // A conversation with no entries has a header-only Pi session and nothing to branch from. The
    // server answers 409 `conversation_not_branchable` -- it used to be a bare 500, which no client
    // could render. The client shows the server's own words, and this asserts they arrive.
    await launchApp(tester);

    final id = await idOf(tester, Fixture.empty);
    await tester.tap(find.byKey(ValueKey('k-conv-menu-$id')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('k-conv-duplicate-$id')));

    // `pumpAndSettle` would return before the server had even answered: it settles *frames*, and an
    // HTTP response schedules none until it lands.
    await pumpUntil(tester, find.textContaining('nothing to branch from'));
    expect(find.textContaining('nothing to branch from'), findsOneWidget);
  });

  testWidgets('forking a user message makes a new chat and leaves the original alone', (
    tester,
  ) async {
    await launchApp(tester);

    final originalId = await idOf(tester, Fixture.withHistory);
    final before = await serverMessageCount(originalId);

    await tapAt(tester, find.text(Fixture.withHistory));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    // The fork icon hangs off the USER turn. There is nothing to fork from the model's answer.
    final fork = find.byWidgetPredicate(
      (w) =>
          w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith('k-msg-fork-'),
    );
    expect(
      fork,
      findsOneWidget,
      reason: 'exactly one user turn in the fixture',
    );

    await tester.tap(fork);

    // The new conversation is opened, and it says where it came from.
    await pumpUntil(tester, find.byKey(const ValueKey('k-chat-branched')));
    expect(find.textContaining('original is unchanged'), findsOneWidget);

    // **...and the original really is unchanged, which is a claim about the SERVER.**
    //
    // This used to assert the original was still *in the sidebar* — which is a desktop assertion
    // wearing a general one's clothes. Below the 760px breakpoint the chat **replaces** the list
    // (`workbench_screen.dart`), so on a phone there is no sidebar on screen to look in, and the
    // check failed on a layout that was behaving perfectly. The banner already says the original is
    // unchanged; this is what makes that sentence *true* rather than merely present.
    expect(await serverHasConversation(Fixture.withHistory), isTrue);
    expect(
      await serverMessageCount(originalId),
      before,
      reason:
          'a fork branches into a NEW session; it must not touch the one it came from',
    );
  });

  testWidgets('a deleted chat can be taken back, and never reaches the server', (
    tester,
  ) async {
    // The delete is **held**, not undone: the server's delete is irreversible the moment it lands.
    // Undo must mean it never happens at all -- which only a real server can prove.
    final chat = await createOwnConversation('the delete test');
    await launchApp(tester);

    final id = chat.id;
    await tester.tap(find.byKey(ValueKey('k-conv-menu-$id')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('k-conv-delete-$id')));
    await tester.pumpAndSettle();

    // Hidden at once.
    expect(find.text(chat.title), findsNothing);

    await tester.tap(find.byKey(ValueKey('k-conv-undo-$id')));
    await tester.pumpAndSettle();

    expect(find.text(chat.title), findsOneWidget);

    // Wait out the window it *would* have fired in, then ask the **server**. The UI alone cannot
    // tell "hidden" from "gone" -- and the whole claim is that an undone delete never happened.
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(
      await serverHasConversation(chat.title),
      isTrue,
      reason: 'an undone delete must never reach the server',
    );
  });
}
