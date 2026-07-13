import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/chat/chat_view.dart';
import 'package:nelle_agent/src/features/conversations/conversation_list_panel.dart';

import '../helpers/fake_dio.dart';

/// **Fork and clone are different acts, in different places.**
///
/// A **fork** branches at one of *your* messages — a new conversation that replays that prompt
/// down its own path. It is a transcript action, and it hangs off a **user** turn, because there
/// is nothing to fork from the model's answer. (The server refuses that with
/// `conversation_not_branchable`.)
///
/// A **clone** copies the whole conversation. It is a sidebar action and needs no entry at all.
///
/// Collapsing them into one "duplicate" is the obvious mistake, and it loses the ability to
/// branch a chat mid-thought — which is the only one of the two that is hard to do any other way.

Map<String, dynamic> _msg(String id, String role, String content) => {
  'id': id,
  'role': role,
  'content': content,
  'createdAt': '2026-07-13T00:00:00.000Z',
};

Map<String, dynamic> _listItem(String id) => {
  'id': id,
  'title': 'Chat $id',
  'titleSource': 'user',
  'pinned': false,
  'status': 'ready',
  'updatedAt': '2026-07-13T00:00:00.000Z',
};

void main() {
  group('the fork action', () {
    Widget host({
      bool canFork = true,
      String? forkKind,
      void Function(String path, Object? body)? onPost,
    }) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.method == 'POST' && o.path.contains('/fork')) {
              onPost?.call(o.path, o.data);
              return jsonResponse({
                'conversation': _listItem('forked'),
                'snapshot': snapshotJson(),
              });
            }
            if (o.path == '/api/conversations') {
              return jsonResponse({
                'conversations': [_listItem('c')],
                'total': 1,
              });
            }
            final snapshot = snapshotJson(
              messages: [
                _msg('e-user', 'user', 'The prompt'),
                _msg('e-assistant', 'assistant', 'The answer'),
              ],
            );
            (snapshot['capabilities'] as Map)['canFork'] = canFork;
            if (forkKind != null) {
              (snapshot['conversation'] as Map)['forkKind'] = forkKind;
            }
            return jsonResponse({'snapshot': snapshot});
          }),
        ),
      ],
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          child: const FToaster(
            child: FScaffold(child: ChatView(conversationId: 'c')),
          ),
        ),
      ),
    );

    testWidgets('hangs off a USER turn, never the model answer', (tester) async {
      // A fork replays *your* prompt. There is nothing to fork from the assistant's reply --
      // regenerate is the action that belongs there, and it re-answers in place instead.
      await tester.pumpWidget(host());
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-msg-fork-e-user')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-msg-fork-e-assistant')), findsNothing);
      // ...and the mirror holds: regenerate is on the answer, not the prompt.
      expect(
        find.byKey(const ValueKey('k-msg-regenerate-e-assistant')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('k-msg-regenerate-e-user')), findsNothing);
    });

    testWidgets('is hidden when the server says the chat cannot be forked', (
      tester,
    ) async {
      // `canFork` is the server's word -- an `unavailable` conversation has no Pi session to
      // branch. It has been on every snapshot since M1 with nothing reading it.
      await tester.pumpWidget(host(canFork: false));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-msg-fork-e-user')), findsNothing);
    });

    testWidgets('sends the message entry id it branches at', (tester) async {
      // `message.id` **is** the Pi entry id (`buildConversationMessages` maps `entry.piEntryId`
      // straight onto it), which is what makes this work at all.
      String? path;
      Object? body;
      await tester.pumpWidget(
        host(
          onPost: (p, b) {
            path = p;
            body = b;
          },
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-msg-fork-e-user')));
      await tester.pumpAndSettle();

      expect(path, contains('/fork'));
      expect(body, {'entryId': 'e-user'});
    });

    testWidgets('a branched chat SAYS it is one, and that the original survives', (
      tester,
    ) async {
      // A fork's transcript looks like an ordinary chat that begins mid-thought. Without this
      // banner the user cannot tell where it came from -- or that the original is untouched,
      // which is the whole reason forking needs no confirmation.
      await tester.pumpWidget(host(forkKind: 'fork'));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-chat-branched')), findsOneWidget);
      expect(find.textContaining('original is unchanged'), findsOneWidget);
    });

    testWidgets('an ordinary chat shows no banner', (tester) async {
      await tester.pumpWidget(host());
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-chat-branched')), findsNothing);
    });
  });

  group('the duplicate action', () {
    Widget host({int cloneStatus = 200}) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio((o) {
            if (o.path.contains('/clone')) {
              if (cloneStatus != 200) {
                return jsonResponse({
                  'error': {
                    'code': 'conversation_not_branchable',
                    'message':
                        'This conversation has no messages yet, so there is nothing to branch from.',
                  },
                }, status: cloneStatus);
              }
              return jsonResponse({
                'conversation': _listItem('cloned'),
                'snapshot': snapshotJson(),
              });
            }
            return jsonResponse({
              'conversations': [_listItem('1')],
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

    testWidgets('lives in the sidebar menu and opens the copy', (tester) async {
      // A duplicate you cannot see is indistinguishable from a button that did nothing.
      await tester.pumpWidget(host());
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('k-conv-duplicate-1')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('k-conv-duplicate-1')));
      await tester.pumpAndSettle();

      // The copy is in the list, at the top -- it is the most recently touched thing there is.
      expect(find.text('Chat cloned'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an empty chat cannot be duplicated, and says why', (
      tester,
    ) async {
      // There is genuinely nothing to copy: Nelle binds a header-only Pi session at creation, so
      // a chat with no messages has no entries to branch. The server refuses it with a code
      // rather than making an empty copy that looks like it worked.
      await tester.pumpWidget(host(cloneStatus: 409));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-duplicate-1')));
      await tester.pumpAndSettle();

      // The server's own sentence, not a client guess at which of the reasons applied.
      expect(find.textContaining('nothing to branch from'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  });
}
