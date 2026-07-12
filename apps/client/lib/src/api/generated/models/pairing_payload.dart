// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'pairing_payload.g.dart';

@JsonSerializable()
class PairingPayload {
  const PairingPayload({
    required this.lanUrls,
    required this.tlsPort,
    required this.certFingerprint,
    required this.code,
    required this.expiresAt,
  });

  factory PairingPayload.fromJson(Map<String, Object?> json) =>
      _$PairingPayloadFromJson(json);

  final List<String> lanUrls;
  final int tlsPort;
  final String? certFingerprint;
  final String code;
  final String expiresAt;

  Map<String, Object?> toJson() => _$PairingPayloadToJson(this);
}
