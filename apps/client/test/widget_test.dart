import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/core/config.dart';
import 'package:nelle_agent/src/features/connection/server_connection.dart';
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

  test('the connection defaults to loopback, unpaired and unpinned', () async {
    SharedPreferences.setMockInitialValues({});
    final container = containerWith(await SharedPreferences.getInstance());

    final connection = container.read(connectionProvider);
    expect(connection.baseUrl, defaultServerBaseUrl);
    expect(connection.isLoopback, isTrue);
    expect(connection.isPaired, isFalse);
    expect(connection.certFingerprint, isNull);
    // The desktop must keep working exactly as it did: no pairing, no keyring, no
    // tokens. Loopback is trusted by the server because arriving there is proof of
    // local access.
    expect(container.read(serverBaseUrlProvider), defaultServerBaseUrl);
  });

  test('setting the base URL persists and updates the derived URL', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = containerWith(prefs);

    await container
        .read(connectionProvider.notifier)
        .setBaseUrl('http://192.168.1.5:8787');

    expect(container.read(serverBaseUrlProvider), 'http://192.168.1.5:8787');
    expect(prefs.getString('server_base_url'), 'http://192.168.1.5:8787');
  });

  test('a blank base URL falls back to the default', () async {
    SharedPreferences.setMockInitialValues({});
    final container = containerWith(await SharedPreferences.getInstance());

    await container.read(connectionProvider.notifier).setBaseUrl('   ');

    expect(container.read(serverBaseUrlProvider), defaultServerBaseUrl);
  });

  test('pairing stores the URL, the pin and the device id together', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = containerWith(prefs);

    await container
        .read(connectionProvider.notifier)
        .setPaired(
          baseUrl: 'https://192.168.4.75:8788',
          certFingerprint: '6F:20:CC:5E',
          deviceId: 'device-1',
        );

    final connection = container.read(connectionProvider);
    expect(connection.baseUrl, 'https://192.168.4.75:8788');
    expect(connection.certFingerprint, '6F:20:CC:5E');
    expect(connection.deviceId, 'device-1');
    expect(connection.isPaired, isTrue);
    expect(connection.isLoopback, isFalse);
    // Survives a relaunch: a rebuilt notifier reads it back off the same prefs.
    expect(containerWith(prefs).read(connectionProvider), connection);
  });

  test('pointing at a new URL drops the previous pin and device id', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = containerWith(prefs);

    await container
        .read(connectionProvider.notifier)
        .setPaired(
          baseUrl: 'https://192.168.4.75:8788',
          certFingerprint: '6F:20:CC:5E',
          deviceId: 'device-1',
        );
    await container
        .read(connectionProvider.notifier)
        .setBaseUrl('http://192.168.1.9:8787');

    // The pin and the id belonged to the *other* server. Carrying them over would
    // pin one server's certificate against another server's address, which either
    // refuses every connection or -- worse -- silently trusts the wrong host.
    final connection = container.read(connectionProvider);
    expect(connection.certFingerprint, isNull);
    expect(connection.deviceId, isNull);
    expect(connection.isPaired, isFalse);
    expect(prefs.getString('server_cert_fingerprint'), isNull);
    expect(prefs.getString('server_device_id'), isNull);
  });

  test('unpairing falls back to loopback and forgets everything', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final container = containerWith(prefs);

    await container
        .read(connectionProvider.notifier)
        .setPaired(
          baseUrl: 'https://192.168.4.75:8788',
          certFingerprint: '6F:20:CC:5E',
          deviceId: 'device-1',
        );
    // What happens when the server revokes this device: the refresh token is refused,
    // and continuing to present it would 401 every request for the rest of time.
    await container.read(connectionProvider.notifier).unpair();

    expect(
      container.read(connectionProvider),
      const ServerConnection.loopback(),
    );
    expect(prefs.getString('server_device_id'), isNull);
  });

  test('a localhost URL on any port is loopback; a LAN address is not', () {
    expect(
      const ServerConnection(baseUrl: 'http://localhost:9999').isLoopback,
      isTrue,
    );
    expect(
      const ServerConnection(baseUrl: 'https://192.168.4.75:8788').isLoopback,
      isFalse,
    );
  });
}
