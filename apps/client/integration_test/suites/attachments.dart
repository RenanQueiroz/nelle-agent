import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/attachments/attachment_draft.dart';

import '../helpers/device_harness.dart';

/// Attachments, against a **real `POST /api/uploads`**.
///
/// The client's attachment tests all stub dio, so they prove it *sends* a multipart body — never
/// that the server accepts one, classifies it, and answers something a chip can render. The web
/// app's Playwright suite did drive the real upload route; when it goes, nothing does. This is
/// what replaces it, and it is a stronger test, because it drives the client that is being kept.
///
/// The **file picker itself is not driven**, and that is deliberate rather than a shortcut: it is
/// the operating system's dialog, not Nelle's. Our code starts at the bytes, which is exactly
/// where `addBytes` starts — the same call the paste and drag-and-drop paths make.
void attachmentsSuite() {
  /// The provider container of the running app, so a test can reach the real notifier.
  ProviderContainer containerOf(WidgetTester tester) =>
      ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));

  testWidgets('a real file is uploaded, and the server names what it will send', (
    tester,
  ) async {
    final chat = await createOwnConversation('an attachment');
    await launchApp(tester);

    await tester.tap(find.text(chat.title));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    final id = chat.id;
    final draft = containerOf(tester).read(attachmentDraftProvider(id).notifier);

    // A real multipart POST to the real server, which classifies it and reads its text.
    await draft.addBytes(
      bytes: Uint8List.fromList(utf8.encode('the pelican is a large water bird')),
      filename: 'pelicans.txt',
      mimeType: 'text/plain',
    );
    await tester.pumpAndSettle();

    final state = containerOf(tester).read(attachmentDraftProvider(id));
    expect(state.error, isNull, reason: 'the server accepted it');
    expect(state.uploads, hasLength(1));

    final uploadId = state.uploads.single.upload.uploadId;
    // A chip, keyed by the id the *server* minted -- not one the client invented.
    await pumpUntil(tester, find.byKey(ValueKey('k-composer-chip-$uploadId')));
    expect(find.text('pelicans.txt'), findsOneWidget);
  });

  testWidgets('the server refuses a binary posing as text, in its own words', (
    tester,
  ) async {
    // The client does not sniff file contents and must not: the server owns the classification,
    // and its refusal names the file. A client that invented its own message would eventually
    // disagree with the server about what is acceptable.
    final chat = await createOwnConversation('a bad attachment');
    await launchApp(tester);

    await tester.tap(find.text(chat.title));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    final id = chat.id;
    final draft = containerOf(tester).read(attachmentDraftProvider(id).notifier);

    await draft.addBytes(
      // NUL bytes: not text, whatever the extension and the mime type claim.
      bytes: Uint8List.fromList([0x00, 0x01, 0x02, 0x00, 0x03]),
      filename: 'lies.txt',
      mimeType: 'text/plain',
    );
    await tester.pumpAndSettle();

    final state = containerOf(tester).read(attachmentDraftProvider(id));
    expect(state.uploads, isEmpty, reason: 'nothing was staged');
    expect(state.error, isNotNull, reason: "the server's sentence, not the client's");
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-attach-error')));
  });

  testWidgets('removing a chip DELETES the upload on the server', (tester) async {
    // **The claim worth testing.** `remove()` deletes; `clear()` does not -- because after a run
    // starts those uploads are a message. If `remove` only dropped the chip, the bytes would sit
    // on the server until the 24h sweep, and a user who removed a file would not have removed it.
    //
    // Asserted against the **server**, because the UI cannot tell "chip gone" from "upload gone".
    final chat = await createOwnConversation('a removed attachment');
    await launchApp(tester);

    await tester.tap(find.text(chat.title));
    await pumpUntil(tester, find.byKey(const ValueKey('k-composer-input')));

    final id = chat.id;
    final draft = containerOf(tester).read(attachmentDraftProvider(id).notifier);
    await draft.addBytes(
      bytes: Uint8List.fromList(utf8.encode('delete me')),
      filename: 'doomed.txt',
      mimeType: 'text/plain',
    );
    await tester.pumpAndSettle();

    final uploadId = containerOf(
      tester,
    ).read(attachmentDraftProvider(id)).uploads.single.upload.uploadId;
    await pumpUntil(tester, find.byKey(ValueKey('k-composer-chip-$uploadId')));

    // The user changes their mind, through the real button.
    await tester.tap(find.byKey(ValueKey('k-composer-chip-remove-$uploadId')));
    await tester.pumpAndSettle();

    expect(find.byKey(ValueKey('k-composer-chip-$uploadId')), findsNothing);

    // ...and it is really gone. Deleting it again is a 404 -- the server has no such draft, which
    // is only true if the chip's remove actually reached it.
    expect(
      await serverDeleteStatus('/api/uploads/$uploadId'),
      404,
      reason: 'removing a chip must delete the upload, not merely hide it',
    );
  });
}
