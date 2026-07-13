import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_exception.dart';
import 'package:nelle_agent/src/features/conversations/conversations_repository.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _listItem({String id = 'c1', bool pinned = false}) => {
  'id': id,
  'title': 'A chat',
  'titleSource': 'user',
  'pinned': pinned,
  'status': 'ready',
  'updatedAt': '2026-07-13T00:00:00.000Z',
};

Map<String, dynamic> _created({String id = 'new-1'}) => {
  'conversation': _listItem(id: id),
  'snapshot': snapshotJson(),
};

void main() {
  group('ConversationsRepository', () {
    test('list parses conversations and total', () async {
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'conversations': [
              {
                'id': '1',
                'title': 'A',
                'titleSource': 'user',
                'pinned': true,
                'status': 'ready',
                'updatedAt': 't',
              },
            ],
            'total': 5,
            'nextCursor': 'cur',
          }),
        ),
      );

      final page = await repo.list();

      expect(page.total, 5);
      expect(page.nextCursor, 'cur');
      expect(page.conversations.single.title, 'A');
      expect(page.conversations.single.pinned, true);
    });

    test('create returns the new conversation', () async {
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'conversation': {
              'id': '9',
              'title': 'New',
              'titleSource': 'fallback',
              'pinned': false,
              'status': 'ready',
              'updatedAt': 't',
            },
          }),
        ),
      );

      final created = await repo.create(title: 'New');

      expect(created.id, '9');
      expect(created.title, 'New');
    });

    test('a non-2xx NelleError body becomes a NelleApiException', () async {
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'error': {'code': 'conversation_not_found', 'message': 'nope'},
          }, status: 404),
        ),
      );

      await expectLater(
        repo.list(),
        throwsA(
          isA<NelleApiException>()
              .having((e) => e.code, 'code', 'conversation_not_found')
              .having((e) => e.statusCode, 'statusCode', 404),
        ),
      );
    });

    test('delete URL-encodes the conversation id', () async {
      String? seenPath;
      final repo = ConversationsRepository(
        stubDio((o) {
          seenPath = o.path;
          return jsonResponse({'ok': true});
        }),
      );

      await repo.delete('a/b');

      expect(seenPath, contains('a%2Fb'));
    });
  });

  /// **Export answers bytes, and a *failed* export answers JSON.** Asking dio for
  /// `ResponseType.bytes` means a refusal arrives as raw bytes too -- which
  /// `NelleApiException.fromResponse` cannot read, so the user would get "Request failed" for
  /// something the server explained in a sentence.
  group('export', () {
    test('answers the archive bytes and the SERVER filename, intact', () async {
      // The name comes off `content-disposition`, not from the title. The server already slugged
      // it, and it is what the user will see in Files or Drive -- a second client re-deriving it
      // would invent a second name for the same archive.
      final zip = Uint8List.fromList([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
      final repo = ConversationsRepository(
        stubDio((o) => bytesResponse(zip, filename: 'a-chat.nelle-chat.zip')),
      );

      final archive = await repo.export('c1');
      expect(archive.bytes, zip);
      expect(archive.filename, 'a-chat.nelle-chat.zip');
    });

    test('a server that names nothing still yields a usable filename', () async {
      // Never an empty name: the user has to be able to find the file afterwards.
      final repo = ConversationsRepository(
        stubDio((o) => bytesResponse(const [1, 2, 3])),
      );

      final archive = await repo.export('c1');
      expect(archive.filename, endsWith('.nelle-chat.zip'));
    });

    test('asks for BYTES, not a parsed body', () async {
      // Without `ResponseType.bytes`, dio decodes the zip as text and hands back mojibake that no
      // `.zip` will ever open from.
      ResponseType? asked;
      final repo = ConversationsRepository(
        stubDio((o) {
          asked = o.responseType;
          return bytesResponse(const [1, 2, 3]);
        }),
      );

      await repo.export('c1');
      expect(asked, ResponseType.bytes);
    });

    test('a REFUSED export reports the server sentence, not "request failed"', () async {
      final repo = ConversationsRepository(
        stubDio(
          (o) => ResponseBody.fromBytes(
            utf8.encode(
              jsonEncode({
                'error': {
                  'code': 'conversation_not_found',
                  'message': 'Conversation c9 was not found.',
                },
              }),
            ),
            404,
            headers: {
              Headers.contentTypeHeader: [Headers.jsonContentType],
            },
          ),
        ),
      );

      await expectLater(
        repo.export('c9'),
        throwsA(
          isA<NelleApiException>()
              .having((e) => e.code, 'code', 'conversation_not_found')
              .having((e) => e.message, 'message', contains('was not found')),
        ),
      );
    });
  });

  group('import', () {
    test('sends the zip as the raw BODY, not as multipart', () async {
      // `/api/uploads` is multipart; this is not. The server reads `ctx.req.arrayBuffer()`
      // directly, so a multipart envelope makes the zip unreadable and the server answers
      // `invalid_archive_upload` -- a confusing thing to debug from the client side.
      final zip = Uint8List.fromList([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]);
      Uint8List? sent;
      String? contentType;
      final repo = ConversationsRepository(
        stubDio(
          (o) {
            contentType = o.contentType;
            return jsonResponse(_created());
          },
          onRequestBytes: (bytes) => sent = bytes,
        ),
      );

      final result = await repo.import(zip);

      expect(contentType, 'application/zip');
      expect(sent, zip, reason: 'the body IS the zip, with nothing wrapped around it');
      expect(result.conversation.id, 'new-1');
    });

    test('a refused archive surfaces the server code', () async {
      // An archive exported from a conversation whose Pi session was already lost. Exporting it
      // was allowed on purpose; importing it must not silently produce an empty chat.
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'error': {
              'code': 'archive_session_missing',
              'message': 'This archive has no Pi session and cannot be imported.',
            },
          }, status: 400),
        ),
      );

      await expectLater(
        repo.import(Uint8List.fromList([1, 2, 3])),
        throwsA(
          isA<NelleApiException>().having(
            (e) => e.code,
            'code',
            'archive_session_missing',
          ),
        ),
      );
    });
  });

  group('fork and clone', () {
    test('a fork sends its entryId; a clone sends no body at all', () async {
      // That is the whole difference. A fork branches *at a message* and must say which; a clone
      // duplicates the conversation and has nothing to say.
      final paths = <String>[];
      final bodies = <Object?>[];
      final repo = ConversationsRepository(
        stubDio((o) {
          paths.add(o.path);
          bodies.add(o.data);
          return jsonResponse(_created());
        }),
      );

      await repo.fork('c1', 'entry-7');
      expect(paths.last, endsWith('/fork'));
      expect(bodies.last, {'entryId': 'entry-7'});

      await repo.clone('c1');
      expect(paths.last, endsWith('/clone'));
      expect(bodies.last, isNull, reason: 'a clone needs no body');
    });

    test('an impossible branch is a coded refusal, never a crash', () async {
      // Cloning an empty conversation, or forking from the model's answer. Both are the client
      // asking for something that cannot exist; both used to be a 500 with no code.
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'error': {
              'code': 'conversation_not_branchable',
              'message':
                  'This conversation has no messages yet, so there is nothing to branch from.',
            },
          }, status: 409),
        ),
      );

      await expectLater(
        repo.clone('empty'),
        throwsA(
          isA<NelleApiException>()
              .having((e) => e.code, 'code', 'conversation_not_branchable')
              .having((e) => e.message, 'message', contains('nothing to branch from')),
        ),
      );
    });
  });

  group('the rest of the lifecycle', () {
    test('pin and unpin are different routes, not a body flag', () async {
      final paths = <String>[];
      final repo = ConversationsRepository(
        stubDio((o) {
          paths.add(o.path);
          return jsonResponse({'conversation': _listItem(pinned: true)});
        }),
      );

      await repo.setPinned('c1', true);
      expect(paths.last, endsWith('/pin'));

      await repo.setPinned('c1', false);
      expect(paths.last, endsWith('/unpin'));
    });

    test('rename PATCHes the title', () async {
      Object? body;
      String? method;
      final repo = ConversationsRepository(
        stubDio((o) {
          method = o.method;
          body = o.data;
          return jsonResponse({'conversation': _listItem()});
        }),
      );

      await repo.rename('c1', 'A better name');
      expect(method, 'PATCH');
      expect(body, {'title': 'A better name'});
    });

    test('diagnostics say why, and unwrap the envelope', () async {
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'diagnostics': {
              'conversationId': 'c1',
              'status': 'unavailable',
              'piSessionPath': '/data/pi/c1.jsonl',
              'exists': false,
              'reason': 'ENOENT: no such file or directory',
              'projectionEntryCount': 12,
              'attachmentCount': 1,
              'toolAuditCount': 0,
            },
          }),
        ),
      );

      final diagnostics = await repo.diagnostics('c1');
      expect(diagnostics.exists, isFalse);
      expect(diagnostics.reason, contains('ENOENT'));
      // The ceiling on what a rebuild could give back.
      expect(diagnostics.projectionEntryCount, 12);
    });

    test('repair and rebuild are different routes and both answer a snapshot', () async {
      final paths = <String>[];
      final repo = ConversationsRepository(
        stubDio((o) {
          paths.add(o.path);
          return jsonResponse({'snapshot': snapshotJson()});
        }),
      );

      await repo.repair('c1');
      expect(paths.last, endsWith('/repair'));

      await repo.rebuild('c1');
      expect(paths.last, endsWith('/rebuild'));
    });

    test('a repair that cannot succeed says so, rather than pretending', () async {
      // Repair never invents a session file. A 409 means the file is still gone -- which is what
      // tells the user that rebuild (lossy) is the one remaining choice.
      final repo = ConversationsRepository(
        stubDio(
          (o) => jsonResponse({
            'error': {
              'code': 'session_unavailable',
              'message': 'Pi session file is missing.',
            },
          }, status: 409),
        ),
      );

      await expectLater(
        repo.repair('c1'),
        throwsA(
          isA<NelleApiException>().having((e) => e.code, 'code', 'session_unavailable'),
        ),
      );
    });

    test('search is sent to the SERVER, and an empty one is not a search', () async {
      // The sidebar holds a *window* onto the list, so filtering it client-side would report "no
      // matching chats" for every conversation the user has not scrolled to yet.
      Map<String, dynamic>? query;
      final repo = ConversationsRepository(
        stubDio((o) {
          query = o.queryParameters;
          return jsonResponse({
            'conversations': [_listItem()],
            'total': 1,
          });
        }),
      );

      await repo.list(search: 'needle');
      expect(query?['search'], 'needle');

      await repo.list(search: '');
      expect(query?.containsKey('search'), isFalse);
    });
  });
}
