import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/app.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

/// A keyboard taller than the window must not take the app down.
///
/// `FScaffold` sizes its body as `maxHeight - max(viewInsets.bottom, footerHeight)` and does not
/// clamp the result (forui 0.23), so an inset larger than the viewport yields a *negative*
/// maximum height and Flutter throws `BoxConstraints has non-normalized height constraints`. It
/// is not hypothetical: it failed a device test on the iOS Simulator that was doing nothing more
/// exotic than typing into the composer, with `0.0<=h<=-97.1`.
void main() {
  testWidgets('a keyboard taller than the viewport does not crash the app', (
    tester,
  ) async {
    // Short viewport, tall keyboard — the degenerate state, reproduced exactly.
    tester.view.physicalSize = const Size(402, 300);
    tester.view.devicePixelRatio = 1.0;
    tester.view.viewInsets = const FakeViewPadding(bottom: 397);
    addTearDown(tester.view.reset);

    SharedPreferences.setMockInitialValues(<String, Object>{});
    final prefs = await SharedPreferences.getInstance();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          dioProvider.overrideWithValue(
            stubDio((options) {
              if (options.method == 'POST' &&
                  options.path.endsWith('/api/conversations')) {
                return jsonResponse({
                  'conversation': {
                    'id': 'c1',
                    'title': 'New chat',
                    'titleSource': 'fallback',
                    'pinned': false,
                    'status': 'ready',
                    'updatedAt': '2026-01-01T00:00:00.000Z',
                  },
                });
              }
              if (RegExp(r'/api/conversations/[^/]+$').hasMatch(options.path)) {
                return jsonResponse({'snapshot': snapshotJson()});
              }
              return jsonResponse({'conversations': <Object?>[], 'total': 0});
            }),
          ),
        ],
        child: const NelleApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      tester.takeException(),
      isNull,
      reason:
          'the keyboard inset must be clamped to the height there is, not handed '
          'to FScaffold to subtract past zero',
    );
  });
}
