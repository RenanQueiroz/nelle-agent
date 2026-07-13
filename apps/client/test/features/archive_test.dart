import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/conversations/archive_service.dart';
import 'package:nelle_agent/src/features/conversations/conversation_list_panel.dart';

import '../helpers/fake_dio.dart';

/// **Export cannot save a file on a phone**, and that is not a preference — it is what the
/// packages implement. `file_selector_android` has exactly three methods (`openFile`, `openFiles`,
/// `getDirectoryPath`); `getSaveLocation` exists on linux/windows/macOS/web and **nowhere else**,
/// where the platform interface's default throws `UnimplementedError`. So the desktop gets a Save
/// dialog and mobile gets the share sheet, which is the only thing that actually reaches a phone's
/// storage.
///
/// Nothing about that is visible while developing on a desktop, which is exactly why it is pinned
/// here.

Map<String, dynamic> _item(String id) => {
  'id': id,
  'title': 'Chat $id',
  'titleSource': 'user',
  'pinned': false,
  'status': 'ready',
  'updatedAt': '2026-07-13T00:00:00.000Z',
};

/// Records what it was asked to do, and answers as if the user went through with it.
class FakeArchiveService implements ArchiveService {
  FakeArchiveService({this.picked, this.savedTo = '/tmp/out.zip'});

  final Uint8List? picked;
  final String? savedTo;

  Uint8List? saved;
  String? savedFilename;
  int pickCalls = 0;

  @override
  Future<String?> save(Uint8List bytes, String filename) async {
    saved = bytes;
    savedFilename = filename;
    return savedTo;
  }

  @override
  Future<Uint8List?> pick() async {
    pickCalls++;
    return picked;
  }
}

void main() {
  group('the platform split', () {
    tearDown(() => debugDefaultTargetPlatformOverride = null);

    test('a phone shares; a desktop saves', () {
      // `getSaveLocation` throws `UnimplementedError` on Android and iOS. Handing a phone the
      // desktop service is not a worse experience -- it is an exception.
      final container = ProviderContainer();
      addTearDown(container.dispose);

      debugDefaultTargetPlatformOverride = TargetPlatform.android;
      expect(
        container.refresh(archiveServiceProvider),
        isA<MobileArchiveService>(),
      );

      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      expect(
        container.refresh(archiveServiceProvider),
        isA<MobileArchiveService>(),
      );

      debugDefaultTargetPlatformOverride = TargetPlatform.linux;
      expect(
        container.refresh(archiveServiceProvider),
        isA<DesktopArchiveService>(),
      );

      debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
      expect(
        container.refresh(archiveServiceProvider),
        isA<DesktopArchiveService>(),
      );

      debugDefaultTargetPlatformOverride = TargetPlatform.windows;
      expect(
        container.refresh(archiveServiceProvider),
        isA<DesktopArchiveService>(),
      );
    });
  });

  group('export', () {
    Widget host(FakeArchiveService archive, {int status = 200}) => ProviderScope(
      overrides: [
        archiveServiceProvider.overrideWithValue(archive),
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.path.contains('/export')) {
              if (status != 200) {
                return ResponseBody.fromBytes(
                  utf8.encode(
                    jsonEncode({
                      'error': {
                        'code': 'conversation_not_found',
                        'message': 'Conversation c1 was not found.',
                      },
                    }),
                  ),
                  status,
                  headers: {
                    Headers.contentTypeHeader: [Headers.jsonContentType],
                  },
                );
              }
              return bytesResponse(
                const [0x50, 0x4b, 0x03, 0x04, 7],
                filename: 'chat-1.nelle-chat.zip',
              );
            }
            return jsonResponse({
              'conversations': [_item('1')],
              'total': 1,
            });
          }),
        ),
      ],
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          child: const FToaster(
            child: FScaffold(
              child: SizedBox(width: 320, child: ConversationListPanel()),
            ),
          ),
        ),
      ),
    );

    testWidgets('hands the archive bytes and the server name to the platform', (
      tester,
    ) async {
      final archive = FakeArchiveService();
      await tester.pumpWidget(host(archive));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-export-1')));
      await tester.pumpAndSettle();

      expect(archive.saved, [0x50, 0x4b, 0x03, 0x04, 7]);
      // The server's name, not one the client invented from the title.
      expect(archive.savedFilename, 'chat-1.nelle-chat.zip');
      expect(find.textContaining('Exported to'), findsOneWidget);
    });

    testWidgets('backing out of the save dialog is not a failure', (
      tester,
    ) async {
      // `null` means the user closed the dialog. Reporting that as an error would be rude.
      final archive = FakeArchiveService(savedTo: null);
      await tester.pumpWidget(host(archive));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-export-1')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Exported to'), findsNothing);
      expect(find.textContaining('failed'), findsNothing);
    });

    testWidgets('a refused export shows the server sentence, not "request failed"', (
      tester,
    ) async {
      // The request asked for bytes, so the 404's JSON body arrives as bytes too. Handing that
      // to `NelleApiException` unread throws away the one thing the user could act on.
      final archive = FakeArchiveService();
      await tester.pumpWidget(host(archive, status: 404));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-export-1')));
      await tester.pumpAndSettle();

      expect(find.textContaining('was not found'), findsOneWidget);
      expect(archive.saved, isNull, reason: 'nothing to save');
    });
  });

  group('import', () {
    Widget host(FakeArchiveService archive, {int status = 200}) => ProviderScope(
      overrides: [
        archiveServiceProvider.overrideWithValue(archive),
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.path.contains('/import')) {
              if (status != 200) {
                return jsonResponse({
                  'error': {
                    'code': 'archive_session_missing',
                    'message':
                        'This archive has no Pi session and cannot be imported.',
                  },
                }, status: status);
              }
              return jsonResponse({
                'conversation': _item('imported'),
                'snapshot': snapshotJson(),
              });
            }
            return jsonResponse({
              'conversations': [_item('1')],
              'total': 1,
            });
          }),
        ),
      ],
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          child: const FToaster(
            child: FScaffold(
              child: SizedBox(width: 320, child: ConversationListPanel()),
            ),
          ),
        ),
      ),
    );

    testWidgets('creates a NEW conversation and opens it', (tester) async {
      // Import is never a merge -- the same archive imported twice gives you two chats. Merging
      // two histories of one conversation has no correct answer, so the server does not try.
      final archive = FakeArchiveService(
        picked: Uint8List.fromList([0x50, 0x4b, 0x03, 0x04]),
      );
      await tester.pumpWidget(host(archive));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-import')));
      await tester.pumpAndSettle();

      expect(archive.pickCalls, 1);
      expect(find.text('Chat imported'), findsOneWidget);
    });

    testWidgets('backing out of the picker does nothing at all', (tester) async {
      final archive = FakeArchiveService(); // picked == null
      await tester.pumpWidget(host(archive));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-import')));
      await tester.pumpAndSettle();

      expect(find.textContaining('failed'), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an archive with no Pi session is refused, and says why', (
      tester,
    ) async {
      // Exporting a broken chat is *allowed* -- you should be able to salvage your data. Importing
      // that archive must not silently produce an empty conversation, which looks like success.
      final archive = FakeArchiveService(
        picked: Uint8List.fromList([0x50, 0x4b]),
      );
      await tester.pumpWidget(host(archive, status: 400));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-import')));
      await tester.pumpAndSettle();

      expect(find.textContaining('no Pi session'), findsOneWidget);
    });
  });
}
