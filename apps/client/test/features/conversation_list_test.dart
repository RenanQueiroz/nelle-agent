import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_list_item_title_source.dart';
import 'package:nelle_agent/src/features/conversations/conversation_list_panel.dart';
import 'package:nelle_agent/src/features/conversations/conversations_notifier.dart';

import '../helpers/fake_dio.dart';

Map<String, dynamic> _item(String id, {String? title, bool pinned = false}) => {
  'id': id,
  'title': title ?? 'Chat $id',
  'titleSource': 'user',
  'pinned': pinned,
  'status': 'ready',
  'updatedAt': '2026-07-13T00:00:00.000Z',
};

/// A container whose list route answers [pages] in order, recording every query it was asked.
({ProviderContainer container, List<Map<String, dynamic>> queries}) _harness(
  List<Object> responses, {
  void Function(RequestOptions options)? onRequest,
}) {
  final queries = <Map<String, dynamic>>[];
  var index = 0;
  final container = ProviderContainer(
    overrides: [
      dioProvider.overrideWithValue(
        stubDio((o) {
          onRequest?.call(o);
          if (o.method == 'GET' && o.path == '/api/conversations') {
            queries.add(Map.of(o.queryParameters));
          }
          final body = responses[index.clamp(0, responses.length - 1)];
          index++;
          return jsonResponse(body);
        }),
      ),
    ],
  );
  addTearDown(container.dispose);
  return (container: container, queries: queries);
}

void main() {
  group('search', () {
    test('goes to the SERVER, and carries into the next page', () async {
      // The sidebar holds a *window* onto the list. Filtering the loaded rows client-side would
      // report "no matching chats" for every conversation the user has not scrolled to yet -- and
      // dropping the search on page two would page them straight back out of their own results.
      final h = _harness([
        {
          'conversations': [_item('1')],
          'total': 1,
          'nextCursor': 'cur-1',
        },
        {
          'conversations': [_item('2')],
          'total': 9,
          'nextCursor': 'cur-2',
        },
        {
          'conversations': [_item('3')],
          'total': 9,
        },
      ]);
      final notifier = h.container.read(conversationsProvider.notifier);
      await h.container.read(conversationsProvider.future);

      await notifier.search('needle');
      expect(h.queries[1]['search'], 'needle');
      expect(
        h.container.read(conversationsProvider).value!.total,
        9,
        reason: 'total is every MATCH, not the number loaded',
      );

      await notifier.loadMore();
      expect(h.queries[2]['search'], 'needle', reason: 'page two is still the search');
      expect(h.queries[2]['cursor'], 'cur-2');
    });

    test('a stale answer cannot overwrite a newer one', () async {
      // Typing puts several searches in flight and they do not come back in order. A slow "n"
      // landing after a fast "needle" would leave the list showing results for a query the user
      // has already typed past -- with the box saying one thing and the list showing another.
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              final search = o.queryParameters['search'] as String?;
              if (search == null) {
                return jsonResponse({
                  'conversations': [_item('0')],
                  'total': 1,
                });
              }
              return jsonResponse({
                'conversations': [_item(search)],
                'total': 1,
              });
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      // Fire two searches; the second must win regardless of which resolves last.
      final first = notifier.search('n');
      final second = notifier.search('needle');
      await Future.wait([first, second]);

      final state = container.read(conversationsProvider).value!;
      expect(state.search, 'needle');
      expect(state.items.single.id, 'needle');
    });

    test('an empty result set says the search matched nothing, not that there are no chats', () async {
      // "No chats yet" claims the user has no conversations. What actually happened is that this
      // word does not appear in any of them.
      final h = _harness([
        {
          'conversations': [_item('1')],
          'total': 1,
        },
        {'conversations': <Object>[], 'total': 0},
      ]);
      await h.container.read(conversationsProvider.future);
      await h.container.read(conversationsProvider.notifier).search('zzz');

      final state = h.container.read(conversationsProvider).value!;
      expect(state.isEmpty, isTrue);
      expect(state.search, 'zzz');
    });
  });

  group('delete', () {
    test('is HELD, not sent -- and undo means it never happens at all', () async {
      // The server's delete is irreversible the moment it lands: it removes the Pi session file
      // and every attachment nothing else references. So there is nothing to undo *afterwards* --
      // it can only be not done. Before this, one tap on a trash icon destroyed a conversation
      // with no confirmation and no way back.
      var deleteCalls = 0;
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              if (o.method == 'DELETE') {
                deleteCalls++;
                return jsonResponse({'ok': true});
              }
              return jsonResponse({
                'conversations': [_item('1'), _item('2')],
                'total': 2,
              });
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.deleteConversation('1');
      var state = container.read(conversationsProvider).value!;
      expect(state.recent.map((c) => c.id), ['2'], reason: 'hidden at once');
      expect(deleteCalls, 0, reason: 'the request is HELD, not sent');
      // The header counts what is on screen. Leaving it at 2 puts "Chats (2)" above one row --
      // the header contradicting the list, which is how the drive found this.
      expect(state.visibleTotal, 1);
      expect(state.total, 2, reason: 'the server still has it; that is why undo can work');

      notifier.undoDelete('1');
      state = container.read(conversationsProvider).value!;
      expect(state.recent.map((c) => c.id), ['1', '2'], reason: 'the row comes back');
      expect(state.visibleTotal, 2, reason: 'and so does the count');

      // ...and the window closing must not now fire the delete it was told to forget.
      await Future<void>.delayed(kDeleteUndoWindow + const Duration(milliseconds: 100));
      expect(deleteCalls, 0, reason: 'an undone delete NEVER reaches the server');
    });

    test('a delete left alone commits when the window closes', () async {
      var deleteCalls = 0;
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              if (o.method == 'DELETE') {
                deleteCalls++;
                return jsonResponse({'ok': true});
              }
              return jsonResponse({
                'conversations': [_item('1')],
                'total': 1,
              });
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.deleteConversation('1');
      await Future<void>.delayed(kDeleteUndoWindow + const Duration(milliseconds: 200));

      expect(deleteCalls, 1);
      final state = container.read(conversationsProvider).value!;
      expect(state.items, isEmpty);
      expect(state.total, 0);
    });

    test('a pending row is hidden from a refresh, so it cannot come back from the dead', () async {
      // The row is still on the server -- the request has not been sent yet -- so any list reload
      // inside the window would happily return it.
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio(
              (o) => jsonResponse({
                'conversations': [_item('1'), _item('2')],
                'total': 2,
              }),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.deleteConversation('1');
      await notifier.loadMore(); // any list traffic, really

      final state = container.read(conversationsProvider).value!;
      expect(
        state.recent.map((c) => c.id),
        isNot(contains('1')),
        reason: 'a deleted row must not be resurrected by a reload',
      );
    });
  });

  group('rename and pin', () {
    test('apply the row the server answers with', () async {
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              if (o.method == 'PATCH') {
                return jsonResponse({
                  'conversation': _item('1', title: 'Renamed'),
                });
              }
              if (o.path.endsWith('/pin')) {
                return jsonResponse({
                  'conversation': _item('1', title: 'Renamed', pinned: true),
                });
              }
              return jsonResponse({
                'conversations': [_item('1'), _item('2')],
                'total': 2,
              });
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      await notifier.rename('1', 'Renamed');
      expect(
        container.read(conversationsProvider).value!.items.first.title,
        'Renamed',
      );

      await notifier.setPinned('1', true);
      final state = container.read(conversationsProvider).value!;
      // The sections are *derived* from `pinned`, so the row moves on its own.
      expect(state.pinned.map((c) => c.id), ['1']);
      expect(state.recent.map((c) => c.id), ['2']);
    });
  });

  group('a generated title (applyGeneratedTitle)', () {
    // The reported bug: the sidebar showed "New chat" forever. A title the server generates after
    // the first exchange arrives as `conversation.updated` (folded by the chat controller), but the
    // list is loaded once and only mutated by explicit actions, so nothing applied it.

    Map<String, dynamic> fallbackItem(String id) => {
      'id': id,
      'title': 'New chat',
      'titleSource': 'fallback',
      'pinned': false,
      'status': 'ready',
      'updatedAt': '2026-07-13T00:00:00.000Z',
    };

    ProviderContainer seeded(List<Map<String, dynamic>> items) {
      final container = ProviderContainer(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio(
              (o) => jsonResponse({'conversations': items, 'total': items.length}),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('replaces a fallback row title in place', () async {
      final container = seeded([fallbackItem('1')]);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.applyGeneratedTitle('1', 'One word greeting');

      final row = container.read(conversationsProvider).value!.items.single;
      expect(row.title, 'One word greeting');
      expect(row.titleSource, ConversationListItemTitleSource.generated);
    });

    test('never clobbers a title the user set', () async {
      // The server refuses to generate over a user title, so the event should not arrive for one —
      // but if a stale one does, a rename must win.
      final container = seeded([_item('1', title: 'My name')]); // titleSource: 'user'
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.applyGeneratedTitle('1', 'Something else');

      expect(
        container.read(conversationsProvider).value!.items.single.title,
        'My name',
      );
    });

    test('ignores an unknown id and an empty title', () async {
      final container = seeded([fallbackItem('1')]);
      final notifier = container.read(conversationsProvider.notifier);
      await container.read(conversationsProvider.future);

      notifier.applyGeneratedTitle('nope', 'x');
      notifier.applyGeneratedTitle('1', '');

      expect(
        container.read(conversationsProvider).value!.items.single.title,
        'New chat',
      );
    });
  });

  group('the panel', () {
    Widget host(List<Map<String, dynamic>> items) => ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(
          stubDio(
            (o) => jsonResponse({
              'conversations': items,
              'total': items.length,
            }),
          ),
        ),
      ],
      child: MaterialApp(
        theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
        home: FTheme(
          data: FThemes.neutral.light.desktop,
          // The real app wraps the tree in an `FToaster` (`app.dart`), and the delete toast needs
          // one. A host without it is a tree the app does not have.
          child: const FToaster(
            child: FScaffold(
              child: SizedBox(width: 320, child: ConversationListPanel()),
            ),
          ),
        ),
      ),
    );

    testWidgets('offers a search box and a row menu, not a bare trash icon', (
      tester,
    ) async {
      await tester.pumpWidget(host([_item('1')]));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-conv-search')), findsOneWidget);
      // The menu replaced a one-tap irreversible delete.
      expect(find.byKey(const ValueKey('k-conv-menu-1')), findsOneWidget);
    });

    testWidgets('the menu offers rename, pin and delete', (tester) async {
      await tester.pumpWidget(host([_item('1')]));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('k-conv-rename-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-conv-pin-1')), findsOneWidget);
      expect(find.byKey(const ValueKey('k-conv-delete-1')), findsOneWidget);
      expect(find.text('Pin'), findsOneWidget);
    });

    testWidgets('renaming does not use the controller after disposing it', (
      tester,
    ) async {
      // **Found by driving, and it crashed the whole app to a red screen.**
      //
      // `showFDialog(...).whenComplete(controller.dispose)` disposes the controller when the
      // *future* completes -- which is the moment `Navigator.pop` is called, while the dialog is
      // still **animating out**. Its `FTextField` keeps rebuilding against the controller for
      // those few frames and throws "A TextEditingController was used after being disposed".
      //
      // Every widget test passed, because none of them pumped past the exit animation.
      // `pumpAndSettle` does, which is what makes this test see it.
      await tester.pumpWidget(host([_item('1')]));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-rename-1')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const ValueKey('k-conv-rename-field')),
        'A new name',
      );
      await tester.tap(find.byKey(const ValueKey('k-conv-rename-save')));
      // Settling runs the dialog's exit animation to completion -- which is exactly when the
      // disposed controller was still being read.
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });

    testWidgets('cancelling a rename is not a rename to nothing', (
      tester,
    ) async {
      await tester.pumpWidget(host([_item('1')]));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-rename-1')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('k-conv-rename-cancel')));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      // The title is untouched.
      expect(find.text('Chat 1'), findsOneWidget);
    });

    testWidgets('a pinned row offers Unpin, not Pin', (tester) async {
      await tester.pumpWidget(host([_item('1', pinned: true)]));
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const ValueKey('k-conv-menu-1')));
      await tester.pumpAndSettle();

      expect(find.text('Unpin'), findsOneWidget);
      expect(find.text('Pin'), findsNothing);
    });
  });
}
