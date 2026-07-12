import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config.dart';

/// A dio client bound to the configured server base URL, rebuilt when that URL
/// changes. Non-2xx responses are returned rather than thrown, so callers can
/// read `NelleError` bodies off the wire.
final dioProvider = Provider<Dio>((ref) {
  final baseUrl = ref.watch(serverBaseUrlProvider);
  final dio = Dio(
    BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 30),
      validateStatus: (_) => true,
      headers: const {'accept': 'application/json'},
    ),
  );
  ref.onDispose(dio.close);
  return dio;
});
