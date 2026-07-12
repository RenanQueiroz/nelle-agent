import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/connection/server_connection.dart';
import 'package:nelle_agent/src/features/conversations/conversations_notifier.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../helpers/fake_dio.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the conversation list reloads when the app changes server', () async {
    // Found on Android, and only there. A phone's first launch cannot reach loopback --
    // there is no server on the phone -- so the list fails, the user pairs, and then
    // sits looking at "Can't reach the server" until they find the Retry button. The
    // notifier `read` the repository instead of watching it, so a connection change
    // (pairing, disconnecting, or a revoked device unpairing itself) never rebuilt it.
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();

    var calls = 0;
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        dioProvider.overrideWith((ref) {
          // Rebuilt whenever the connection changes -- which is the mechanism under test.
          ref.watch(connectionProvider);
          return stubDio((options) {
            calls += 1;
            return jsonResponse({'conversations': <Object?>[], 'total': 0});
          });
        }),
      ],
    );
    addTearDown(container.dispose);

    await container.read(conversationsProvider.future);
    expect(calls, 1);

    // Pair: a different server entirely.
    await container
        .read(connectionProvider.notifier)
        .setPaired(
          baseUrl: 'https://192.168.4.75:8788',
          certFingerprint: '6F:20:CC:5E',
          deviceId: 'device-1',
        );
    await container.read(conversationsProvider.future);

    expect(
      calls,
      2,
      reason:
          'the list it was showing belonged to the server we just stopped talking to',
    );
  });
}
