import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/attachments/attachment_draft.dart';
import 'package:nelle_agent/src/features/attachments/paste_to_file.dart';

import '../helpers/fake_dio.dart';

/// The clipboard is a platform channel; a test has to answer it.
void _clipboard(WidgetTester tester, String text) {
  tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    (call) async =>
        call.method == 'Clipboard.getData' ? <String, dynamic>{'text': text} : null,
  );
  addTearDown(
    () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      null,
    ),
  );
}

Future<ProviderContainer> _pump(
  WidgetTester tester,
  TextEditingController controller, {
  required int? threshold,
}) async {
  final c = ProviderContainer(
    overrides: [
      dioProvider.overrideWithValue(
        stubDio((o) {
          if (o.path == '/api/settings/attachments') {
            return jsonResponse({'pasteToFileCharacters': ?threshold});
          }
          return jsonResponse({
            'uploadId': 'u1',
            'kind': 'text',
            'name': 'pasted.txt',
            'sizeBytes': 9000,
            'warnings': <String>[],
          }, status: 201);
        }),
      ),
    ],
  );
  addTearDown(c.dispose);

  // Nothing here fetches the settings. The widget must *watch* them when it mounts, or
  // the threshold is unknown when the paste arrives — `read` on a provider nobody has
  // watched returns AsyncLoading and merely starts the request, so the very first long
  // paste, the one anyone actually notices, would land in the message.
  await tester.runAsync(() async {
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c,
        child: MaterialApp(
          home: Scaffold(
            body: PasteToFile(
              conversationId: 'c',
              controller: controller,
              child: TextField(controller: controller, autofocus: true),
            ),
          ),
        ),
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 60));
  });
  await tester.pump();
  return c;
}

Future<void> _paste(WidgetTester tester) async {
  await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a paste under the threshold still just pastes', (tester) async {
    // Intercepting means owning it: consuming the shortcut stops the field pasting for
    // itself, so a short paste has to be inserted here or it vanishes.
    final controller = TextEditingController();
    _clipboard(tester, 'short');
    await _pump(tester, controller, threshold: 100);

    await _paste(tester);

    expect(controller.text, 'short');
  });

  testWidgets('a paste over the threshold becomes a .txt attachment', (
    tester,
  ) async {
    final controller = TextEditingController();
    _clipboard(tester, 'x' * 5000);
    final c = await _pump(tester, controller, threshold: 100);

    await tester.runAsync(() async {
      await _paste(tester);
      // The upload is a real round trip, fired and not awaited by the shortcut. Under
      // FakeAsync it would never run at all.
      await Future<void>.delayed(const Duration(milliseconds: 100));
    });
    await tester.pump();

    // Forty thousand characters in the input helps nobody.
    expect(controller.text, isEmpty);
    expect(c.read(attachmentDraftProvider('c')).uploadIds, ['u1']);
  });

  testWidgets('with no threshold from the server, every paste stays in the message', (
    tester,
  ) async {
    // The client ships no copy of the default. A stale constant would silently turn a
    // paste into a file against a server that had disabled it.
    final controller = TextEditingController();
    _clipboard(tester, 'y' * 5000);
    final c = await _pump(tester, controller, threshold: null);

    await _paste(tester);

    expect(controller.text.length, 5000);
    expect(c.read(attachmentDraftProvider('c')).uploads, isEmpty);
  });

  testWidgets('0 disables it, exactly as the setting says', (tester) async {
    final controller = TextEditingController();
    _clipboard(tester, 'z' * 5000);
    final c = await _pump(tester, controller, threshold: 0);

    await _paste(tester);

    expect(controller.text.length, 5000);
    expect(c.read(attachmentDraftProvider('c')).uploads, isEmpty);
  });
}
