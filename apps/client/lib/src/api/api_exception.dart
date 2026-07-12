import 'package:dio/dio.dart';

import 'generated/models/nelle_error.dart';

/// Raised when a request fails. Carries the server's structured `NelleError`
/// (stable `code`) when the response had one, or a network/transport message.
class NelleApiException implements Exception {
  NelleApiException(this.message, {this.code, this.statusCode, this.retryable});

  /// Builds from a non-2xx response, reading the `{error: NelleError}` body when
  /// present.
  factory NelleApiException.fromResponse(Response<dynamic> res) {
    final data = res.data;
    if (data is Map && data['error'] is Map) {
      final error = NelleError.fromJson(
        (data['error'] as Map).cast<String, Object?>(),
      );
      return NelleApiException(
        error.message,
        code: error.code,
        statusCode: res.statusCode,
        retryable: error.retryable,
      );
    }
    return NelleApiException(
      'Request failed (${res.statusCode})',
      statusCode: res.statusCode,
    );
  }

  /// Builds from a dio transport failure (connection refused, timeout, ...).
  factory NelleApiException.network(DioException e) => NelleApiException(
    e.message ?? 'Server unreachable',
    code: 'network_error',
  );

  final String message;
  final String? code;
  final int? statusCode;
  final bool? retryable;

  @override
  String toString() => message;
}
