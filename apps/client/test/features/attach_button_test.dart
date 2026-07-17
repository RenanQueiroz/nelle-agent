import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/features/attachments/attach_button.dart';

/// The attach picker used to swallow its own failure: `openFiles` throwing left an invisible
/// unhandled async exception and the button appeared to do nothing — the exact shape of the macOS
/// App-Sandbox bug, where the open panel was refused for want of the user-selected-file entitlement.
/// A picker failure must surface, not vanish.
///
/// The sandbox denial reaches the app as a `PlatformException` from the picker channel, so the test
/// makes that channel throw one — standing in for any platform/permission failure of the picker.
Widget _host() => ProviderScope(
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      // `showFToast` needs an `FToaster` ancestor, as the real composer has.
      child: const FToaster(
        child: FScaffold(
          child: Center(child: AttachButton(conversationId: 'c1')),
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('a picker failure surfaces a toast, not silence', (tester) async {
    // Make the picker channel throw, the way a sandbox denial (or any platform error) does.
    const channel = MethodChannel('plugins.flutter.io/file_selector');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (call) async => throw PlatformException(
        code: 'denied',
        message: 'the panel was refused',
      ),
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );

    await tester.pumpWidget(_host());

    await tester.tap(find.byKey(const ValueKey('k-composer-attach')));
    await tester.pump(); // dispatch the tap; openFiles rejects; the catch runs
    await tester.pump(
      const Duration(milliseconds: 300),
    ); // the toast animates in

    expect(
      find.textContaining('Could not open the file picker'),
      findsOneWidget,
    );
    // Handled, not an unhandled async exception — the whole point of the change.
    expect(tester.takeException(), isNull);

    // Flush the toast's auto-dismiss timer so it does not outlive the test.
    await tester.pump(const Duration(seconds: 6));
  });

  testWidgets('backing out of the picker is not an error', (tester) async {
    // A cancel yields nothing (`openFiles` returns `[]`); that is not a failure and must not toast.
    const channel = MethodChannel('plugins.flutter.io/file_selector');
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      channel,
      (call) async => null,
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );

    await tester.pumpWidget(_host());

    await tester.tap(find.byKey(const ValueKey('k-composer-attach')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.textContaining('Could not open'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
