import 'package:dio/dio.dart';

/// The web cannot pin a certificate.
///
/// A browser makes the TLS decision itself, before any Dart code runs, and it will
/// simply refuse a self-signed certificate — there is no callback to hook and no way
/// to compare a fingerprint. So LAN mode is native-only, and `-d chrome` stays on
/// loopback. Returning `null` leaves dio's default adapter in place; the pairing UI is
/// what refuses, with a sentence, rather than failing at the handshake with a stack
/// trace nobody can act on.
HttpClientAdapter? pinnedAdapter(String? fingerprint) => null;
