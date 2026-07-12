import 'dart:io';

import 'package:dio/dio.dart';
import 'package:dio/io.dart';

import 'cert_pinning.dart';

/// An HTTP client that trusts the pinned certificate and **nothing else**.
///
/// `badCertificateCallback` fires for any certificate the platform will not validate
/// on its own, which a self-signed one never is. Returning `true` accepts it, so this
/// callback is the entire trust decision: it must compare fingerprints, and it must
/// refuse when they differ. Returning `true` unconditionally — the fix every snippet
/// on the internet suggests — disables TLS verification altogether and would accept
/// any certificate any attacker on the network cared to present.
HttpClientAdapter? pinnedAdapter(String? fingerprint) {
  if (fingerprint == null || fingerprint.isEmpty) {
    return null; // Loopback: plain HTTP, nothing to pin, normal validation elsewhere.
  }
  return IOHttpClientAdapter(
    createHttpClient: () {
      final client = HttpClient();
      client.badCertificateCallback = (certificate, host, port) =>
          certificateMatchesPin(certificate.der, fingerprint);
      return client;
    },
  );
}
