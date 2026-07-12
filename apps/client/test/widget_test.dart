import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  ProviderContainer containerWith(SharedPreferences prefs) {
    final container = ProviderContainer(
      overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('server base URL defaults to loopback when unset', () async {
    SharedPreferences.setMockInitialValues({});
    final container = containerWith(await SharedPreferences.getInstance());
    expect(container.read(serverBaseUrlProvider), defaultServerBaseUrl);
  });

  test('setting the base URL persists and updates state', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = containerWith(prefs);

    await container
        .read(serverBaseUrlProvider.notifier)
        .set('http://192.168.1.5:8787');

    expect(container.read(serverBaseUrlProvider), 'http://192.168.1.5:8787');
    expect(prefs.getString('server_base_url'), 'http://192.168.1.5:8787');
  });

  test('a blank base URL falls back to the default', () async {
    SharedPreferences.setMockInitialValues({});
    final container = containerWith(await SharedPreferences.getInstance());

    await container.read(serverBaseUrlProvider.notifier).set('   ');

    expect(container.read(serverBaseUrlProvider), defaultServerBaseUrl);
  });
}
