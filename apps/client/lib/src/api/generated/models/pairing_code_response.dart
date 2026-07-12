// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'pairing_payload.dart';

part 'pairing_code_response.g.dart';

@JsonSerializable()
class PairingCodeResponse {
  const PairingCodeResponse({
    required this.code,
    required this.expiresAt,
    required this.qrPayload,
  });

  factory PairingCodeResponse.fromJson(Map<String, Object?> json) =>
      _$PairingCodeResponseFromJson(json);

  final String code;
  final String expiresAt;
  final PairingPayload qrPayload;

  Map<String, Object?> toJson() => _$PairingCodeResponseToJson(this);
}
