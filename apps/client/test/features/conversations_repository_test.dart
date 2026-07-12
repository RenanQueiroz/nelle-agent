import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_exception.dart';
import 'package:nelle_agent/src/features/conversations/conversations_repository.dart';

import '../helpers/fake_dio.dart';

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
}
