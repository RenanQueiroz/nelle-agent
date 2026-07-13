import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
/// **The assumption the whole device suite rests on.**
///
/// `flutter_test` installs an `HttpOverrides` that makes every real network call fail — which is
/// correct for a widget test (they stub dio) and fatal for a device test (they must reach a real
/// server). `integration_test` runs the app on a real device and *should* leave the network alone,
/// but "should" is not a thing to build a milestone on.
///
/// So this runs first, and it is the reason T1 exists before T2: if this fails, the entire design
/// — a fixture server the app talks to over loopback — is wrong, and it is much cheaper to find
/// that out now than after two tiers of tests are written against it.
void httpProbeSuite() {
  test('a device test can make a REAL HTTP request', () async {
    // Not to the Nelle server -- to a socket this test owns, so the probe cannot pass or fail for
    // any reason except the one it is asking about.
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));

    server.listen((request) {
      request.response
        ..statusCode = 200
        ..write('{"ok":true}')
        ..close();
    });

    final client = HttpClient();
    addTearDown(client.close);
    final request = await client.getUrl(
      Uri.parse('http://127.0.0.1:${server.port}/probe'),
    );
    final response = await request.close();
    final body = await response.transform(const SystemEncoding().decoder).join();

    expect(response.statusCode, 200);
    expect(body, contains('"ok":true'));
  });

  test('HttpOverrides is not installed', () {
    // The direct statement of it. `flutter_test` sets `HttpOverrides.global` to something that
    // throws on every request; a device binding must leave it null.
    expect(
      HttpOverrides.current,
      isNull,
      reason: 'a device test must be able to reach a real server',
    );
  });
}
