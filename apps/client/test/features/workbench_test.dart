import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/conversations/conversation_list_panel.dart';
import 'package:nelle_agent/src/features/workbench/workbench_screen.dart';

import '../helpers/fake_dio.dart';

/// The home opens **on a chat**, Claude-style: the newest untouched conversation is
/// reused, else one is created — and the history lives in a sidebar (persistent and
/// collapsible on a desktop, a hamburger sheet on a phone). These tests pin that shape.
void main() {
  Map<String, dynamic> item(
    String id, {
    String titleSource = 'user',
    String title = 'Some chat',
  }) => {
    'id': id,
    'title': title,
    'titleSource': titleSource,
    'pinned': false,
    'status': 'ready',
    'updatedAt': '2026-01-01T00:00:00.000Z',
  };

  Future<int> pumpWorkbench(
    WidgetTester tester, {
    required Size size,
    List<Map<String, dynamic>> conversations = const [],
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    var created = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.method == 'POST' &&
                  options.path.endsWith('/api/conversations')) {
                created++;
                return jsonResponse({
                  'conversation': item('c-created', titleSource: 'fallback'),
                });
              }
              if (RegExp(
                r'/api/conversations/[^/]+$',
              ).hasMatch(options.path)) {
                return jsonResponse({'snapshot': snapshotJson()});
              }
              return jsonResponse({
                'conversations': conversations,
                'total': conversations.length,
              });
            }),
          ),
        ],
        child: MaterialApp(
          theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
          home: FTheme(
            data: FThemes.neutral.light.desktop,
            child: const FToaster(child: WorkbenchScreen()),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return created;
  }

  testWidgets('opens straight into a fresh chat when none can be reused', (
    tester,
  ) async {
    final created = await pumpWorkbench(
      tester,
      size: const Size(1280, 900),
      conversations: [item('c1')],
    );

    // A titled chat is not "untouched", so one POST created a fresh one — and the
    // composer is on screen without a single tap.
    expect(created, 1);
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);
  });

  testWidgets('reuses the newest untouched chat instead of littering', (
    tester,
  ) async {
    final created = await pumpWorkbench(
      tester,
      size: const Size(1280, 900),
      conversations: [
        item('c-fresh', titleSource: 'fallback', title: 'New chat'),
        item('c-old'),
      ],
    );

    expect(created, 0);
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);
    // The reused chat is the selected row in the sidebar.
    expect(
      tester
          .widget<FTile>(
            find.byKey(const ValueKey('k-conv-tile-c-fresh')),
          )
          .selected,
      isTrue,
    );
  });

  testWidgets('wide: the header toggle collapses and reopens the sidebar', (
    tester,
  ) async {
    await pumpWorkbench(
      tester,
      size: const Size(1280, 900),
      conversations: [item('c1', titleSource: 'fallback')],
    );
    expect(find.byType(ConversationListPanel), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsNothing);

    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsOneWidget);
  });


  testWidgets('widening while the sheet is open leaves ONE conversation list', (
    tester,
  ) async {
    // The bug: the sheet is a pushed *route*, and a route does not care about layout.
    // Opened while narrow, it survived the crossing back to wide and sat on top of the
    // persistent sidebar — two conversation lists stacked, the sheet's barrier
    // swallowing clicks meant for the app underneath.
    await pumpWorkbench(
      tester,
      size: const Size(500, 900),
      conversations: [item('c1', titleSource: 'fallback', title: 'New chat')],
    );

    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsOneWidget);

    // Drag the window wide.
    tester.view.physicalSize = const Size(1280, 900);
    await tester.pumpAndSettle();

    expect(
      find.byType(ConversationListPanel),
      findsOneWidget,
      reason: 'the sheet must retire so only the persistent sidebar remains',
    );
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);

    // ...and the list that remains is the *persistent* one, driven by the wide-mode
    // toggle. Asserted by interaction rather than by counting barriers: if the sheet
    // were still up, its modal barrier would swallow this tap and the sidebar would
    // stay put.
    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsNothing);
  });

  testWidgets('widening honours the hamburger: a collapsed sidebar reopens', (
    tester,
  ) async {
    // Collapse the desktop sidebar, go narrow, ask for the list with the hamburger,
    // then widen. Retiring the sheet without reading that request would leave the user
    // with no list at all — having just tapped the control that means "show me it".
    await pumpWorkbench(
      tester,
      size: const Size(1280, 900),
      conversations: [item('c1', titleSource: 'fallback', title: 'New chat')],
    );

    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsNothing);

    tester.view.physicalSize = const Size(500, 900);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsOneWidget);

    tester.view.physicalSize = const Size(1280, 900);
    await tester.pumpAndSettle();

    expect(
      find.byType(ConversationListPanel),
      findsOneWidget,
      reason: 'the hamburger asked for the list; widening must not take it away',
    );
    // And it is the *persistent* sidebar, not the sheet still standing in for it:
    // only the sheet's copy carries an `onDestination` (the callback that pops it).
    expect(
      tester
          .widget<ConversationListPanel>(find.byType(ConversationListPanel))
          .onDestination,
      isNull,
      reason: 'the sheet must be gone, replaced by the real sidebar',
    );
  });

  testWidgets('narrow: the chat is the screen and the hamburger opens a sheet', (
    tester,
  ) async {
    await pumpWorkbench(
      tester,
      size: const Size(500, 900),
      conversations: [
        item('c1', titleSource: 'fallback', title: 'New chat'),
        item('c2', title: 'Older chat'),
      ],
    );

    // No persistent sidebar, but the chat is already open.
    expect(find.byType(ConversationListPanel), findsNothing);
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('k-chat-sidebar')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsOneWidget);
    expect(find.text('Older chat'), findsOneWidget);

    // Selecting there closes the sheet and swaps the chat under it.
    await tester.tap(find.byKey(const ValueKey('k-conv-tile-c2')));
    await tester.pumpAndSettle();
    expect(find.byType(ConversationListPanel), findsNothing);
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);
  });
}
