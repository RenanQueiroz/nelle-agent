import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/api_exception.dart';

final _options = RequestOptions(path: '/api/health');

void main() {
  test(
    'a rejected certificate is reported as an identity change, not a network fault',
    () {
      // Found by driving: re-keying the server made the paired client say "Server
      // unreachable", which sends the user to check their wifi. The truth is the opposite
      // -- we *found* the server and refused to trust it.
      //
      // The certificate is stable for five years precisely so a pin holds, so a mismatch
      // means the server was rebuilt or something is impersonating it, and the client
      // cannot tell which. That is what it must say.
      final exception = NelleApiException.network(
        DioException(
          requestOptions: _options,
          type: DioExceptionType.badCertificate,
        ),
      );

      expect(exception.code, 'certificate_mismatch');
      expect(exception.message, contains('pair again'));
      expect(exception.message, contains('impersonating'));
      // Not retryable: retrying will present the same wrong certificate forever.
      expect(exception.retryable, isFalse);
    },
  );

  test('a handshake failure surfacing as a connection error is caught too', () {
    // dart:io throws HandshakeException when badCertificateCallback refuses, and dio
    // does not always classify it as badCertificate.
    final exception = NelleApiException.network(
      DioException(
        requestOptions: _options,
        type: DioExceptionType.connectionError,
        message: 'HandshakeException: Handshake error in client',
      ),
    );

    expect(exception.code, 'certificate_mismatch');
  });

  test('an ordinary network failure stays an ordinary network failure', () {
    // The server really is unreachable: wrong network, server down, wrong address.
    final exception = NelleApiException.network(
      DioException(
        requestOptions: _options,
        type: DioExceptionType.connectionTimeout,
        message: 'Connection timed out',
      ),
    );

    expect(exception.code, 'network_error');
    expect(exception.message, 'Connection timed out');
  });
}
