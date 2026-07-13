import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'helpers/device_harness.dart';

/// **The slow tier: a real model, really generating.**
///
/// Everything else in this suite runs with llama.cpp stopped, because that is fast and because it
/// is the state most error paths live in. But a chat app whose chatting is never tested end to end
/// is a chat app with a hole in the middle of it, and stubbing llama.cpp would test nothing that
/// matters: the whole question is whether Nelle, Pi, llama.cpp and the client agree about a stream
/// of tokens.
///
/// So this loads **gemma-4-E2B** (the small one — the 26B costs tens of seconds and a lot of RAM,
/// which makes a test loop useless) and asks it real questions. It runs on demand:
///
///     bun run test:device:slow
///
/// Not on every commit. A model load plus a generation is minutes, and a suite nobody runs because
/// it is slow is worse than one that is honestly separate.
void main() {
  initDeviceBinding();

  testWidgets('a real message gets a real answer', (tester) async {
    // llama.cpp is running but the model is **not loaded** — the fixture deliberately leaves it
    // that way. So this exercises the whole path: the server loads the weights when the run starts
    // (`ensureModelRunnable`), streams `model.loading` while it waits, then streams the answer. A
    // client that had to poll for the load itself would be a client every other client had to copy.
    //
    // **It brings its own conversation, and that is not just the isolation rule.** The fixture's
    // conversations-with-history are seeded by writing Pi entries *by hand*
    // (`SessionManager.appendMessage`), and such a session can be **read** but not **continued**:
    // Pi's agent replays it and completes without any text at all. Only a session Pi itself created
    // -- which is what `POST /api/conversations` makes -- can be chatted with. The hand-seeded ones
    // are for the fast tier, which never sends a message.
    final title = await createOwnConversation('a real generation');
    await launchApp(tester);

    await tester.tap(find.text(title));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    await tester.enterText(
      find.byKey(const ValueKey('k-composer-input')),
      'Reply with exactly one word: yes',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('k-composer-send')));

    // The weights load first. It is tens of seconds, and the transcript says so rather than sitting
    // blank -- which is the point of `model.loading` carrying progress at all.
    await pumpUntil(
      tester,
      find.textContaining('Loading weights'),
      timeout: const Duration(seconds: 30),
    );

    // ...and then a real answer, from a real model. The run being *over* is what a returned send
    // button means -- and a settled assistant turn is what a regenerate icon means, since the icon
    // is only offered on a message the server has actually persisted.
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('k-composer-send')),
      timeout: const Duration(minutes: 3),
    );

    // A regenerate icon is only offered on an assistant message the server has actually persisted,
    // so its presence is the proof that a real model really answered.
    final answers = find.byWidgetPredicate(
      (w) => w.key is ValueKey<String> &&
          (w.key! as ValueKey<String>).value.startsWith('k-msg-regenerate-'),
    );
    expect(answers, findsOneWidget);
    expect(tester.takeException(), isNull);
  }, timeout: const Timeout(Duration(minutes: 5)));

  testWidgets('a run can be stopped mid-stream', (tester) async {
    // Stopping is not cosmetic: Nelle's llama.cpp proxy forwards the close to the upstream fetch's
    // `AbortSignal`, so the model actually stops generating rather than finishing into a void. And
    // the composer must stay *usable* while a run streams -- a stop button under a `pointer-events:
    // none` overlay is a stop button that cannot be pressed, which is a bug `apps/web` shipped.
    final title = await createOwnConversation('a stopped run');
    await launchApp(tester);

    await tester.tap(find.text(title));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    await tester.enterText(
      find.byKey(const ValueKey('k-composer-input')),
      'Count slowly from 1 to 500, one number per line.',
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('k-composer-send')));

    // Wait until it is genuinely streaming, then stop it.
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('k-composer-stop')),
      timeout: const Duration(minutes: 2),
    );
    await tester.tap(find.byKey(const ValueKey('k-composer-stop')));

    // The stop button goes away because the run is over -- not because the app fell over.
    await pumpUntil(
      tester,
      find.byKey(const ValueKey('k-composer-send')),
      timeout: const Duration(seconds: 60),
    );
    expect(tester.takeException(), isNull);

    // The conversation is `ready` again on the **server**, not merely on screen: an abort that left
    // a stuck `running` row would block every future send.
    final id = await idOf(tester, title);
    final snapshot = await serverGet('/api/conversations/$id');
    final conversation =
        (snapshot['snapshot'] as Map)['conversation'] as Map<String, dynamic>;
    expect(conversation['status'], 'ready');
  }, timeout: const Timeout(Duration(minutes: 5)));
}
