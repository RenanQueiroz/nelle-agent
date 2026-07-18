import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/device_harness.dart';

/// The states the app has to survive, produced by a **real server actually being in them**.
///
/// A widget test can stub a `llama_server_stopped` error and assert the client renders it. It
/// cannot tell you whether the server emits that code, on that route, in that shape, when llama.cpp
/// is genuinely not running. The fixture has no llama.cpp installed at all, so these are not
/// simulated — they are the truth.
void errorsSuite() {
  testWidgets('a message refused before the run starts KEEPS the typed text', (
    tester,
  ) async {
    // **The bug AGENTS names.** "36 passing tests did not catch a refused message silently eating
    // the user's typed text, and one minute of driving the UI did." This is that minute, committed.
    //
    // llama.cpp is not running on the fixture, so the chat route refuses with
    // `llama_server_stopped` *before* `run.started` -- which means the message never became a turn,
    // and the composer must give the text back rather than making the user retype it.
    await launchApp(tester);
    await ensureChatsVisible(tester);

    await tapAt(tester, find.text(Fixture.withHistory));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    const typed = 'A message that will be refused';
    // `typeInto`, not `enterText`: the latter is a silent no-op on an unfocused field, and a test
    // that asserts on text it never actually typed is worse than no test at all.
    await typeInto(
      tester,
      find.byKey(const ValueKey('k-composer-input')),
      typed,
    );
    await tester.tap(find.byKey(const ValueKey('k-composer-send')));

    // The server's own sentence, not a client guess at why. Waited for, not settled for.
    await pumpUntil(tester, find.textContaining('llama.cpp'));
    expect(find.textContaining('llama.cpp'), findsWidgets);

    // ...and the text is still in the box.
    final composer = tester.widget<TextField>(
      find.descendant(
        of: find.byKey(const ValueKey('k-composer-input')),
        matching: find.byType(TextField),
      ),
    );
    expect(
      composer.controller?.text,
      typed,
      reason:
          'a refused message never became a turn; the text is still the user\'s',
    );
  });

  testWidgets('every screen survives llama.cpp being stopped', (tester) async {
    // The fixture has no llama.cpp at all: `/api/llama/models` answers 502 and the router list is
    // null. A screen that treats that as a crash instead of a state is a screen the user cannot
    // open on a fresh install -- which is every install, before they have built it.
    await launchApp(tester);
    await ensureChatsVisible(tester);

    await tester.tap(find.byKey(const ValueKey('k-conv-settings')));

    // `tapAt`, not `tap`: the Models section is below the fold in the settings list, and a tap at
    // off-screen coordinates hits nothing and fails *silently*.
    await tapAt(
      tester,
      find.byKey(const ValueKey('k-settings-section-models')),
    );
    // **Waited for, not settled for** -- and for the *claim itself*: the catalog rendered the
    // fixture's model. (It used to wait on the Models screen's back button, which was a proxy --
    // and a desktop-shaped assertion: two-pane settings hosts the section beside the sidebar
    // with no back button at all, exactly like the workbench's forked-sidebar lesson.)
    await pumpUntil(tester, find.text(Fixture.modelName));

    // The catalog is `models.ini`, not the router -- so the list renders with nothing running.
    expect(tester.takeException(), isNull);
    expect(find.byKey(const ValueKey('k-models-error')), findsNothing);

    // A phone pushed the section, so it must be dismissed before the next tile is reachable;
    // two-pane settings keeps the sidebar on screen, so the next tap needs no back at all.
    final modelsBack = find.byKey(const ValueKey('k-models-back'));
    if (modelsBack.evaluate().isNotEmpty) {
      await tester.tap(modelsBack);
      await tester.pump();
    }
    await tapAt(
      tester,
      find.byKey(const ValueKey('k-settings-section-llamacpp')),
    );
    // Not installed is a state, and the screen says so rather than erroring.
    await pumpUntil(tester, find.textContaining('Not installed'));
    expect(tester.takeException(), isNull);
  });

  testWidgets('a broken conversation offers repair, and rebuild recovers it', (
    tester,
  ) async {
    // The fixture seeds a conversation bound to a Pi session file that was never written. It is
    // `unavailable` the moment anything reads it -- and the client used to render that as an
    // ordinary *empty* chat, telling the user their history was gone when it was recoverable.
    await launchApp(tester);
    await ensureChatsVisible(tester);

    await typeInto(
      tester,
      find.byKey(const ValueKey('k-conv-search')),
      'history is gone',
    );
    await pumpUntil(tester, find.text(Fixture.broken));
    await tapAt(tester, find.text(Fixture.broken));
    await pumpUntil(tester, find.byKey(const ValueKey('k-unavailable-title')));

    expect(find.byKey(const ValueKey('k-unavailable-title')), findsOneWidget);
    // The filesystem's own words.
    expect(find.textContaining('Pi session file is missing'), findsOneWidget);
    // There is no composer: there is nowhere to send a message to.
    expect(find.byKey(const ValueKey('k-composer-input')), findsNothing);

    // **The rebuild warning names what it destroys.** "This is lossy" is not a choice a user can
    // weigh; "you will lose your tool results and your images" is. The count is the server's, from
    // diagnostics -- it is the ceiling on what a rebuild could give back.
    final lossy = tester
        .widget<Text>(find.byKey(const ValueKey('k-unavailable-lossy')))
        .data!;
    expect(
      lossy,
      contains('2 messages'),
      reason: 'the fixture projection has two',
    );
    expect(lossy, contains('tool results'));
    expect(lossy, contains('image content'));
    expect(lossy, contains('compaction summaries'));
    expect(lossy, contains('variants'));

    // Repair cannot succeed -- nobody put the file back, and repair never invents a session. It
    // must say so and leave rebuild standing, rather than pretending.
    await tester.tap(find.byKey(const ValueKey('k-unavailable-repair')));
    await pumpUntil(tester, find.byKey(const ValueKey('k-unavailable-error')));

    expect(find.byKey(const ValueKey('k-unavailable-rebuild')), findsOneWidget);

    // Rebuild reconstructs from the projection. It is lossy, and it said so -- but it *works*.
    await tester.tap(find.byKey(const ValueKey('k-unavailable-rebuild')));
    await pumpUntil(
      tester,
      find.textContaining('A question whose answer is now only in SQLite'),
    );

    // The panel is gone, and the messages the projection still held are on screen.
    expect(find.byKey(const ValueKey('k-unavailable-title')), findsNothing);
  });
}
