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
  ///
  /// A **certificate mismatch is not a network problem**, and must not be reported as
  /// one. The server's certificate is stable for five years precisely so a pin holds, so
  /// a fingerprint that no longer matches means either the server was rebuilt or
  /// something is impersonating it -- and the client cannot tell which. "Server
  /// unreachable" sends the user to check their wifi; the truth is that we found a
  /// server and refused to trust it.
  factory NelleApiException.network(DioException e) {
    if (_isCertificateMismatch(e)) {
      return NelleApiException(
        "The server's certificate is not the one this device paired with. If you "
        'rebuilt the server, pair again. If you did not, something on the network is '
        'impersonating it.',
        code: 'certificate_mismatch',
        retryable: false,
      );
    }
    return NelleApiException(
      e.message ?? 'Server unreachable',
      code: 'network_error',
    );
  }

  /// dio reports a rejected certificate as `badCertificate`, but a `HandshakeException`
  /// can also surface as a plain `connectionError` depending on where it is thrown, so
  /// the underlying error is matched by name too.
  ///
  /// By *name*, not by type: `HandshakeException` lives in `dart:io`, and importing that
  /// here would break the web build -- which is the very thing the conditionally-imported
  /// pinned adapter exists to preserve.
  static bool _isCertificateMismatch(DioException e) {
    if (e.type == DioExceptionType.badCertificate) {
      return true;
    }
    final detail = '${e.error ?? ''} ${e.message ?? ''}';
    return detail.contains('HandshakeException') ||
        detail.contains('CERTIFICATE_VERIFY_FAILED');
  }

  final String message;
  final String? code;
  final int? statusCode;
  final bool? retryable;

  @override
  String toString() => message;
}
