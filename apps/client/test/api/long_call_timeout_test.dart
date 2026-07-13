import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/request.dart';

/// dio's default `receiveTimeout` is 30 seconds, and that number was never chosen for these
/// calls — it is simply what everything *else* needs.
///
/// But `POST /api/runtime/start` waits up to 30 s server-side for llama.cpp's health probe —
/// a coin flip against the default, to the millisecond — and a Hugging Face search walks eight
/// repositories over the network. On a slow day either would fail client-side while the server
/// carried happily on, and the user would be told an operation failed that was in fact
/// succeeding. That is the exact failure the streamed install exists to prevent, and it lives
/// on every long JSON call too.
///
/// A stub adapter cannot prove this: dio enforces receive timeouts in the *adapter*, and ours
/// would simply hand back its canned response. So this runs a real HTTP server that answers
/// slowly, and pins the behaviour rather than the plumbing.
void main() {
  late HttpServer server;
  late String baseUrl;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUrl = 'http://127.0.0.1:${server.port}';
    server.listen((request) async {
      // Slower than the client's default, faster than its long-call override.
      await Future<void>.delayed(const Duration(milliseconds: 400));
      request.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write('{"ok":true}');
      await request.response.close();
    });
  });

  tearDown(() async => server.close(force: true));

  Dio dioWithDefault(Duration receiveTimeout) => Dio(
    BaseOptions(
      baseUrl: baseUrl,
      receiveTimeout: receiveTimeout,
      validateStatus: (_) => true,
    ),
  );

  test('the default timeout kills a slow-but-healthy call', () async {
    // The bug, reproduced: the server is working, and the client gives up on it.
    final dio = dioWithDefault(const Duration(milliseconds: 100));

    await expectLater(
      dio.get<Map<String, dynamic>>('/slow'),
      throwsA(
        isA<DioException>().having(
          (e) => e.type,
          'type',
          DioExceptionType.receiveTimeout,
        ),
      ),
    );
  });

  test('longCall() outlives it, and the call succeeds', () async {
    final dio = dioWithDefault(const Duration(milliseconds: 100));

    final response = await dio.get<Map<String, dynamic>>(
      '/slow',
      options: longCall(),
    );

    expect(response.statusCode, 200);
    expect(response.data, {'ok': true});
  });

  test('the long timeout is comfortably clear of the server waits it covers', () {
    // `POST /api/runtime/start` blocks for up to 30 s while llama.cpp comes up. A margin of
    // seconds would be another coin flip; this is minutes. dio measures it *between bytes*,
    // so a generous value costs a healthy call nothing — it only bounds how long a genuinely
    // wedged one hangs.
    expect(kLongCallTimeout, greaterThan(const Duration(seconds: 30)));
  });
}
