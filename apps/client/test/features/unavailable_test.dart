import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/features/chat/chat_view.dart';

import '../helpers/fake_dio.dart';

/// **The Pi session JSONL *is* the conversation.** SQLite holds only a projection of it.
///
/// So when that file goes missing, the transcript is empty — and the client used to render a
/// broken chat as an ordinary *empty* one, which told the user their conversation was gone when in
/// fact it was sitting right there, recoverable.
///
/// There are three explicit ways out and no implicit ones: no read path may conjure a replacement
/// session, because that would be Nelle inventing a history it does not have.

Widget _host({
  String status = 'unavailable',
  bool exists = false,
  String? reason = 'Pi session file is missing.',
  int projectionEntryCount = 12,
  int repairStatus = 200,
  void Function(String path)? onPost,
}) => ProviderScope(
  overrides: [
    dioProvider.overrideWithValue(
      stubDio((o) {
        if (o.method == 'POST') {
          onPost?.call(o.path);
          if (repairStatus != 200 && o.path.contains('/repair')) {
            return jsonResponse({
              'error': {
                'code': 'session_unavailable',
                'message': 'Pi session file is still missing.',
              },
            }, status: repairStatus);
          }
          return jsonResponse({'snapshot': snapshotJson()});
        }
        if (o.path.contains('/diagnostics')) {
          return jsonResponse({
            'diagnostics': {
              'conversationId': 'c',
              'status': status,
              'piSessionPath': '/data/pi/sessions/c.jsonl',
              'exists': exists,
              'reason': ?reason,
              'projectionEntryCount': projectionEntryCount,
              'attachmentCount': 2,
              'toolAuditCount': 1,
            },
          });
        }
        final snapshot = snapshotJson();
        (snapshot['conversation'] as Map)['status'] = status;
        (snapshot['capabilities'] as Map)['canRepair'] = true;
        (snapshot['capabilities'] as Map)['canSend'] = false;
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

void main() {
  testWidgets('a broken chat is SHOWN as broken, not as an empty one', (
    tester,
  ) async {
    // The bug this replaces: an `unavailable` conversation rendered as an ordinary empty chat with
    // a working composer. The user's history looked deleted, and the two things that could bring
    // it back were nowhere on screen.
    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-unavailable-title')), findsOneWidget);
    // The filesystem's own words -- a client cannot say it better, and guessing sends the user to
    // fix the wrong thing.
    expect(find.text('Pi session file is missing.'), findsOneWidget);
    expect(find.byKey(const ValueKey('k-unavailable-path')), findsOneWidget);
  });

  testWidgets('there is no composer, because there is nowhere to send to', (
    tester,
  ) async {
    // A disabled box the user can type into and watch do nothing is worse than no box at all.
    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-composer-input')), findsNothing);
  });

  testWidgets('the rebuild warning NAMES what it destroys', (tester) async {
    // "This is lossy" is not a choice a user can weigh. "You will lose your tool results and your
    // images" is. The projection is what a rebuild works from, so the count is the ceiling on
    // what it could possibly give back.
    await tester.pumpWidget(_host(projectionEntryCount: 12));
    await tester.pumpAndSettle();

    final lossy = tester
        .widget<Text>(find.byKey(const ValueKey('k-unavailable-lossy')))
        .data!;
    expect(lossy, contains('12 messages'));
    expect(lossy, contains('lossy'));
    expect(lossy, contains('tool results'));
    expect(lossy, contains('image content'));
    expect(lossy, contains('compaction summaries'));
    expect(lossy, contains('variants'));
  });

  testWidgets('repair is offered FIRST, because it is the lossless one', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    await tester.pumpAndSettle();

    final repair = tester.getTopLeft(
      find.byKey(const ValueKey('k-unavailable-repair')),
    );
    final rebuild = tester.getTopLeft(
      find.byKey(const ValueKey('k-unavailable-rebuild')),
    );
    expect(
      repair.dy,
      lessThan(rebuild.dy),
      reason: 'the one that loses nothing comes first',
    );
  });

  testWidgets('repair and rebuild hit their own routes', (tester) async {
    final posted = <String>[];
    await tester.pumpWidget(_host(onPost: posted.add));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-unavailable-repair')));
    await tester.pumpAndSettle();
    expect(posted.last, endsWith('/repair'));

    await tester.tap(find.byKey(const ValueKey('k-unavailable-rebuild')));
    await tester.pumpAndSettle();
    expect(posted.last, endsWith('/rebuild'));
  });

  testWidgets('a successful repair also tells the SIDEBAR', (tester) async {
    // The list row carries the conversation's `status` and does not re-fetch on its own. Without
    // this the chat came fully back -- transcript, composer, regenerate variants and all -- while
    // the sidebar still printed "Unavailable" under its name. Found by driving.
    final listCalls = <String>[];
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          dioProvider.overrideWithValue(
            stubDio((o) {
              if (o.method == 'GET' && o.path == '/api/conversations') {
                listCalls.add(o.path);
                return jsonResponse({
                  'conversations': <Object>[],
                  'total': 0,
                });
              }
              if (o.method == 'POST') {
                return jsonResponse({'snapshot': snapshotJson()});
              }
              if (o.path.contains('/diagnostics')) {
                return jsonResponse({
                  'diagnostics': {
                    'conversationId': 'c',
                    'status': 'unavailable',
                    'exists': false,
                    'projectionEntryCount': 3,
                    'attachmentCount': 0,
                    'toolAuditCount': 0,
                  },
                });
              }
              final snapshot = snapshotJson();
              (snapshot['conversation'] as Map)['status'] = 'unavailable';
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
      ),
    );
    await tester.pumpAndSettle();
    final before = listCalls.length;

    await tester.tap(find.byKey(const ValueKey('k-unavailable-repair')));
    await tester.pumpAndSettle();

    expect(
      listCalls.length,
      greaterThan(before),
      reason: 'the sidebar must be told the conversation is whole again',
    );
  });

  testWidgets('a repair that cannot succeed says so, and the panel stays', (
    tester,
  ) async {
    // Repair never invents a session file. A 409 means it is *still* missing -- which is exactly
    // what tells the user that rebuild is the one remaining choice. Pretending the repair worked
    // would leave them staring at an empty chat with no way forward.
    await tester.pumpWidget(_host(repairStatus: 409));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('k-unavailable-repair')));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-unavailable-error')), findsOneWidget);
    expect(find.textContaining('still missing'), findsOneWidget);
    // ...and rebuild is still there to take.
    expect(find.byKey(const ValueKey('k-unavailable-rebuild')), findsOneWidget);
  });

  testWidgets('losing the diagnostics costs a sentence, not the buttons', (
    tester,
  ) async {
    // Diagnostics are an explanation, not a prerequisite. Hiding the two things that could fix
    // the conversation because a detail could not be fetched would be the worse failure.
    await tester.pumpWidget(_host(reason: null));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-unavailable-repair')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-unavailable-rebuild')), findsOneWidget);
  });

  testWidgets('a healthy conversation shows none of this', (tester) async {
    await tester.pumpWidget(_host(status: 'ready', exists: true, reason: null));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('k-unavailable-title')), findsNothing);
    expect(find.byKey(const ValueKey('k-composer-input')), findsOneWidget);
  });
}
