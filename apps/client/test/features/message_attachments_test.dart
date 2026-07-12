import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata_kind.dart';
import 'package:nelle_agent/src/features/chat/message_attachments.dart';

import '../helpers/fake_dio.dart';

/// A 1x1 transparent PNG -- real bytes, so `Image.memory` actually decodes them.
final _png = Uint8List.fromList([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x63,
  0x00,
  0x01,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0x0d,
  0x0a,
  0x2d,
  0xb4,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
]);

AttachmentMetadata _attachment({
  String id = 'att-1',
  AttachmentMetadataKind kind = AttachmentMetadataKind.image,
  String name = 'photo.png',
}) => AttachmentMetadata(
  id: id,
  conversationId: 'c',
  kind: kind,
  name: name,
  sizeBytes: 2048,
  createdAt: '2026-07-12T20:00:00.000Z',
);

Widget _host(
  List<AttachmentMetadata> attachments, {
  int status = 200,
  List<int>? body,
  List<String>? requested,
}) => ProviderScope(
  overrides: [
    dioProvider.overrideWith((ref) {
      final dio = Dio(
        BaseOptions(baseUrl: 'http://test.local', validateStatus: (_) => true),
      );
      dio.httpClientAdapter = StubAdapter((options) {
        requested?.add(options.path);
        return ResponseBody.fromBytes(body ?? _png, status);
      });
      return dio;
    }),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      child: Scaffold(body: MessageAttachments(attachments: attachments)),
    ),
  ),
);

void main() {
  testWidgets('an image from a past message shows the picture', (tester) async {
    final requested = <String>[];
    await tester.pumpWidget(_host([_attachment()], requested: requested));
    await tester.pumpAndSettle();

    // The bytes are on the server, and on a phone they always will be: the transcript
    // is rebuilt from a snapshot that carries metadata, not pictures.
    expect(requested, ['/api/attachments/att-1/content']);
    expect(find.byType(Image), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('the bytes are fetched through the app client, not Image.network', (
    tester,
  ) async {
    final requested = <String>[];
    await tester.pumpWidget(_host([_attachment()], requested: requested));
    await tester.pumpAndSettle();

    // `Image.network` opens its own HTTP client: no bearer token (so a paired device
    // gets 401) and no knowledge of the pinned certificate (so the handshake fails). It
    // would show a broken image on exactly the device this route was added for. The
    // request going through the stubbed dio adapter is what proves it does not.
    expect(requested, isNotEmpty);
    expect(find.byType(Image), findsOneWidget);
  });

  testWidgets('an image whose bytes are gone falls back to the chip', (
    tester,
  ) async {
    // The file may have been swept. A broken-image icon says less than the name and
    // size already do.
    await tester.pumpWidget(
      _host([_attachment()], status: 404, body: const []),
    );
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('k-msg-attachment-att-1')),
      findsOneWidget,
    );
    expect(find.text('photo.png'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'bytes that will not decode fall back to the chip, not an exception',
    (tester) async {
      await tester.pumpWidget(_host([_attachment()], body: const [1, 2, 3]));
      await tester.pumpAndSettle();

      // Degenerate bytes are still bytes. A picture that cannot decode must not take the
      // transcript down with it.
      expect(
        find.byKey(const ValueKey('k-msg-attachment-att-1')),
        findsOneWidget,
      );
    },
  );

  testWidgets('a PDF or a text file stays a chip and is never fetched', (
    tester,
  ) async {
    final requested = <String>[];
    await tester.pumpWidget(
      _host([
        _attachment(
          id: 'a-pdf',
          kind: AttachmentMetadataKind.pdf,
          name: 'report.pdf',
        ),
        _attachment(
          id: 'a-txt',
          kind: AttachmentMetadataKind.text,
          name: 'notes.txt',
        ),
      ], requested: requested),
    );
    await tester.pumpAndSettle();

    // A PDF has no thumbnail worth 220 pixels and a text file has none at all -- and
    // downloading either to render a chip would be a request for nothing.
    expect(requested, isEmpty);
    expect(
      find.byKey(const ValueKey('k-msg-attachment-a-pdf')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('k-msg-attachment-a-txt')),
      findsOneWidget,
    );
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('no attachments renders nothing at all', (tester) async {
    await tester.pumpWidget(_host(const []));
    await tester.pumpAndSettle();

    expect(find.byType(Image), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
