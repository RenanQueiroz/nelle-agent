import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// Minimal view of `GET /api/health`.
class ServerHealth {
  const ServerHealth({required this.app, this.runtimeStatus});
  final String app;
  final String? runtimeStatus;
}

class ServerUnreachable implements Exception {
  const ServerUnreachable(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Pings `GET /api/health`. Re-runs whenever the base URL (and thus dio) changes;
/// `ref.invalidate(healthProvider)` forces a re-check.
final healthProvider = FutureProvider.autoDispose<ServerHealth>((ref) async {
  final dio = ref.watch(dioProvider);
  final Response<Map<String, dynamic>> res;
  try {
    res = await dio.get<Map<String, dynamic>>('/api/health');
  } on DioException catch (e) {
    throw ServerUnreachable(e.message ?? e.toString());
  }
  final data = res.data;
  if (res.statusCode != 200 || data == null || data['ok'] != true) {
    throw ServerUnreachable('Unexpected response (${res.statusCode})');
  }
  final runtime = data['runtime'];
  return ServerHealth(
    app: (data['app'] as String?) ?? 'nelle',
    runtimeStatus: runtime is Map ? runtime['status'] as String? : null,
  );
});
