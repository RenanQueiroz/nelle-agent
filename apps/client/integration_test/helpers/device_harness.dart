import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:nelle_agent/main.dart' as app;
import 'package:shared_preferences/shared_preferences.dart';

/// What every device test needs before it can drive anything.
///
/// The app under test is the **real** one — `main()`, the real providers, the real dio, real HTTP
/// to a real Nelle server. Nothing is stubbed. That is the entire point: widget tests already stub
/// dio (309 of them), and they cannot see what only appears on a device.

/// The port the fixture server is on.
///
/// Passed in with `--dart-define`, never guessed: the harness that starts the server is the one
/// that knows, and a hard-coded 8787 would point the suite at whatever the developer happens to be
/// running — which is the same class of mistake as a llama.cpp probe on 8080.
const fixturePort = int.fromEnvironment('NELLE_FIXTURE_PORT', defaultValue: 8797);

/// The conversations `scripts/serve-fixture.ts` seeds. Kept in step by hand, because the fixture
/// is TypeScript and this is Dart; a test that looks for a chat the fixture never made fails
/// loudly, which is the failure mode to want.
abstract final class Fixture {
  static const withHistory = 'A conversation with history';
  static const aboutPelicans = 'Everything about pelicans';
  static const empty = 'An empty conversation';

  /// Bound to a Pi session file that was never written -- `unavailable` on first read. Seeded
  /// broken because the test runs *on the device* and cannot reach the host's filesystem.
  static const broken = 'A conversation whose history is gone';

  /// **Not on the first page.** The list pages at 50 and the fixture seeds 65, with this one the
  /// oldest -- so a client-side filter over the loaded rows could never find it, which is the whole
  /// reason search is a server query.
  static const needle = 'Xylophone concerto in B minor';

  /// The one model in `models.ini`. Nothing is downloaded and llama.cpp is not installed — which
  /// is what every fresh install looks like, and what the composer needs before it will even try to
  /// send (and therefore before the server's refusal can happen at all).
  static const modelName = 'unsloth/gemma-4-E2B-it-qat-GGUF:UD-Q4_K_XL';
}

/// Boots the real app, pointed at the fixture server.
///
/// **`127.0.0.1:<port>` is loopback**, so the fixture's trusted listener needs no device token —
/// which means the whole suite runs with no pairing, no TLS, no pin and no keyring. On Android the
/// same address works because the harness runs `adb reverse`, mapping the emulator's own loopback
/// to the host's port. (Pairing is not skipped out of laziness: it is already covered by
/// `devices.test.ts` server-side and three client test files, and making every device test carry a
/// TLS handshake and a Keystore write would be testing the harness.)
///
/// The connection is seeded through `SharedPreferences`, which `main()` reads at startup — so no
/// production code has a test hook in it. It also *overrides* whatever the developer's real app has
/// stored, which on this machine is a paired Android connection to a LAN address.
Future<void> launchApp(WidgetTester tester) async {
  SharedPreferences.setMockInitialValues({
    'server_base_url': 'http://127.0.0.1:$fixturePort',
  });

  app.main();
  await tester.pumpAndSettle(const Duration(seconds: 10));
}

/// The binding, and the one thing it must be true about.
///
/// `flutter_test` installs an `HttpOverrides` that fails every real network call. A device binding
/// must not — the app has to reach the fixture server. `integration_test/http_probe_test.dart`
/// asserts this directly; this is the belt to that's braces, because every other test in the suite
/// silently depends on it.
IntegrationTestWidgetsFlutterBinding initDeviceBinding() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  return binding;
}


/// Asks the **server** a question directly, over the same loopback the app uses.
///
/// A test that can only see the UI cannot tell "the row is hidden" from "the row is gone". The
/// delete-undo test turns on exactly that difference: the request is *held*, so undo must mean it
/// never happened at all -- and the only way to know is to ask the server.
Future<Map<String, dynamic>> serverGet(String path) async {
  final client = HttpClient();
  try {
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:$fixturePort$path'),
    );
    final response = await request.close();
    final body = await response.transform(utf8.decoder).join();
    return jsonDecode(body) as Map<String, dynamic>;
  } finally {
    client.close();
  }
}

/// Whether the server still has a conversation with this title.
Future<bool> serverHasConversation(String title) async {
  final page = await serverGet('/api/conversations?limit=200');
  final conversations = (page['conversations'] as List).cast<Map<String, dynamic>>();
  return conversations.any((c) => c['title'] == title);
}

/// How many messages the server holds for a conversation.
///
/// "The original is unchanged" is a claim about the **server**, and it has to be asserted there.
/// The obvious proxy — "the original is still in the sidebar" — is a *desktop* assertion wearing a
/// general one's clothes: below the 760px breakpoint the chat **replaces** the list, so on a phone
/// there is no sidebar on screen to look in, and the check fails on a layout that is behaving
/// perfectly. (It did. That is what running this suite on Android is for.)
Future<int> serverMessageCount(String conversationId) async {
  final body = await serverGet('/api/conversations/$conversationId');
  final snapshot = body['snapshot'] as Map<String, dynamic>;
  return (snapshot['messages'] as List).length;
}

/// The id of the conversation with this title, from the **server**.
///
/// Row keys are `k-conv-menu-<id>`, and a test cannot know an id the fixture generated. Reading it
/// off the server is honest: the alternative is scraping it out of a widget key, which couples the
/// test to the very keys it is about to assert on.
Future<String> idOf(WidgetTester tester, String title) async {
  final page = await serverGet(
    '/api/conversations?limit=200&search=${Uri.encodeQueryComponent(title)}',
  );
  final conversations = (page['conversations'] as List).cast<Map<String, dynamic>>();
  final match = conversations.firstWhere(
    (c) => c['title'] == title,
    orElse: () => throw StateError('the fixture has no conversation titled "$title"'),
  );
  return match['id'] as String;
}


/// POSTs to the fixture server.
Future<Map<String, dynamic>> serverPost(String path, [Object? body]) async {
  final client = HttpClient();
  try {
    final request = await client.postUrl(
      Uri.parse('http://127.0.0.1:$fixturePort$path'),
    );
    if (body != null) {
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode(body));
    }
    final response = await request.close();
    final text = await response.transform(utf8.decoder).join();
    return text.isEmpty ? <String, dynamic>{} : jsonDecode(text) as Map<String, dynamic>;
  } finally {
    client.close();
  }
}

/// Creates a conversation the calling test **owns**, and answers its title.
///
/// **The seeded fixtures are read-only.** Every test in the suite drives the same server, in one
/// process, in order — so a test that renames a seeded conversation breaks the next test that looks
/// for it by name, which is exactly what happened the first time this suite ran. A test that mutates
/// therefore brings its own conversation, with a title nothing else uses.
///
/// Call it **before** [launchApp]: the sidebar is loaded once at startup, and a conversation created
/// afterwards is not in it.
Future<String> createOwnConversation(String label) async {
  final title = 'Owned by: $label';
  await serverPost('/api/conversations', {'title': title});
  return title;
}


/// Pumps until [finder] matches, or fails after [timeout].
///
/// **`pumpAndSettle` does not wait for network I/O**, and that is the single most important thing
/// to know about writing these. It pumps until no *frame* is scheduled — and an HTTP response
/// schedules no frames until it arrives, so `pumpAndSettle` returns happily while the request is
/// still in flight, and the very next `expect` looks at a screen that has not been told anything
/// yet. Every early failure in this suite was that: a toast not found, a refusal not rendered, a
/// screen not navigated to. (Widget tests never meet this, because `stubDio` answers synchronously.)
///
/// Worse, it fails *quietly* in the other direction too: `expect(finder, findsNothing)` passes
/// vacuously if the app has not got there yet, so a test can go green having checked nothing.
///
/// So: assert **presence** with this, never with a bare `pumpAndSettle`.
Future<void> pumpUntil(
  WidgetTester tester,
  Finder finder, {
  Duration timeout = const Duration(seconds: 15),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      // Let whatever it is finish animating in before the caller reads it.
      await tester.pump(const Duration(milliseconds: 300));
      return;
    }
  }
  throw TestFailure(
    'timed out after ${timeout.inSeconds}s waiting for: '
    '${finder.describeMatch(Plurality.one)}',
  );
}


/// Scrolls [finder] into view, then taps it.
///
/// `find.byKey(...)` matches a widget in the *tree*, and a lazy `ListView` builds a little past the
/// viewport — so a finder can succeed on something the user cannot see, and `tap()` then dispatches
/// a hit test at coordinates that are off-screen and hits nothing. It fails silently: the tap
/// simply does not happen, and the next `pumpUntil` times out on a screen that was never opened.
///
/// (This is the same thing the Marionette drives have always needed a `scroll_to` for. The settings
/// list is the usual victim: Models and llama.cpp are below the fold on a 1280px window and far
/// below it on a phone.)
Future<void> tapAt(WidgetTester tester, Finder finder) async {
  await pumpUntil(tester, finder);
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
}
