import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/attachments/attachment_chips.dart';
import 'package:nelle_agent/src/features/attachments/attachment_draft.dart';

import '../helpers/fake_dio.dart';

Widget _harness(Widget child) => MaterialApp(
  theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
  home: FTheme(
    data: FThemes.neutral.light.desktop,
    child: Scaffold(body: child),
  ),
);

Map<String, dynamic> _upload({
  String id = 'u1',
  String kind = 'text',
  String name = 'note.txt',
  int size = 2048,
  int? pageCount,
  bool? hasTextLayer,
  List<String> warnings = const [],
}) => {
  'uploadId': id,
  'kind': kind,
  'name': name,
  'sizeBytes': size,
  'pageCount': ?pageCount,
  'hasTextLayer': ?hasTextLayer,
  'warnings': warnings,
};

/// A real 1x1 PNG, so an image chip can actually decode its preview.
final _png = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
);

Future<ProviderContainer> _withStaged(
  WidgetTester tester,
  Map<String, dynamic> upload,
) async {
  final c = ProviderContainer(
    overrides: [
      dioProvider.overrideWithValue(
        stubDio((o) => jsonResponse(upload, status: 201)),
      ),
    ],
  );
  addTearDown(c.dispose);
  // Bytes, not a path: a widget test has no filesystem to point at, and `addFile`
  // rightly fails on a file that is not there.
  //
  // `runAsync`, because a widget test runs under FakeAsync and this is a *real* HTTP
  // round trip through dio. Awaited plainly, the future simply never completes and the
  // test hangs rather than fails.
  await tester.runAsync(
    () => c
        .read(attachmentDraftProvider('c').notifier)
        .addBytes(bytes: _png, filename: upload['name'] as String),
  );

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: c,
      child: _harness(const AttachmentChips(conversationId: 'c')),
    ),
  );
  return c;
}

void main() {
  testWidgets('the drawer renders nothing when nothing is attached', (
    tester,
  ) async {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(stubDio((o) => jsonResponse({}))),
      ],
    );
    addTearDown(c.dispose);

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c,
        child: _harness(const AttachmentChips(conversationId: 'c')),
      ),
    );

    // An empty row of chrome above every message is noise.
    expect(find.byType(Wrap), findsNothing);
    expect(tester.getSize(find.byType(AttachmentChips)), Size.zero);
  });

  testWidgets('a chip names the file, its size, and how to remove it', (
    tester,
  ) async {
    await _withStaged(tester, _upload());

    expect(find.byKey(const ValueKey('k-composer-chip-u1')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('k-composer-chip-remove-u1')),
      findsOneWidget,
    );
    expect(find.text('note.txt'), findsOneWidget);
    expect(find.textContaining('2 KB'), findsOneWidget);
  });

  testWidgets('a scan says it will be sent as page images', (tester) async {
    // `hasTextLayer: false` means the server extracted no text, so the model gets page
    // *images* — about 1200 context tokens each. Someone attaching a six-page scan is
    // entitled to know that before they send it.
    await _withStaged(
      tester,
      _upload(
        id: 'u2',
        kind: 'pdf',
        name: 'scan.pdf',
        pageCount: 6,
        hasTextLayer: false,
      ),
    );

    expect(find.textContaining('scan'), findsWidgets);
    expect(find.textContaining('6 page image(s)'), findsOneWidget);
  });

  testWidgets("the server's warnings reach the chip", (tester) async {
    await _withStaged(
      tester,
      _upload(
        id: 'u3',
        kind: 'image',
        name: 'photo.png',
        warnings: ['photo.png was downscaled to 1.5 megapixels.'],
      ),
    );

    // The user is entitled to know what is actually being sent.
    expect(find.textContaining('downscaled'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(
      tester.takeException(),
      isNull,
      reason: 'the preview fixture must be a genuinely decodable image',
    );
  });

  testWidgets('a refusal shows the server sentence, which names the file', (
    tester,
  ) async {
    final c = ProviderContainer(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio(
            (o) => jsonResponse({
              'error': {
                'code': 'unsupported_attachment',
                'message': 'big.bin looks like a binary file.',
              },
            }, status: 400),
          ),
        ),
      ],
    );
    addTearDown(c.dispose);
    await tester.runAsync(
      () => c
          .read(attachmentDraftProvider('c').notifier)
          .addBytes(bytes: Uint8List.fromList([0, 1]), filename: 'big.bin'),
    );

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: c,
        child: _harness(const AttachmentChips(conversationId: 'c')),
      ),
    );

    expect(
      find.byKey(const ValueKey('k-composer-attach-error')),
      findsOneWidget,
    );
    expect(find.textContaining('big.bin'), findsOneWidget);
  });
}
