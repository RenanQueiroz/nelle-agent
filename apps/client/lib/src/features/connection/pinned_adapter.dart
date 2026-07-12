import 'package:dio/dio.dart';

export 'pinned_adapter_stub.dart' if (dart.library.io) 'pinned_adapter_io.dart';

/// Builds an adapter that trusts exactly one self-signed certificate, or `null` when
/// the platform cannot pin (the web) or there is nothing to pin (loopback).
typedef PinnedAdapterBuilder = HttpClientAdapter? Function(String? fingerprint);
