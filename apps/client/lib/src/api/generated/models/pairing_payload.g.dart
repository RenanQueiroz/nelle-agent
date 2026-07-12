// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'pairing_payload.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PairingPayload _$PairingPayloadFromJson(Map<String, dynamic> json) =>
    PairingPayload(
      lanUrls: (json['lanUrls'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      tlsPort: (json['tlsPort'] as num).toInt(),
      certFingerprint: json['certFingerprint'] as String?,
      code: json['code'] as String,
      expiresAt: json['expiresAt'] as String,
    );

Map<String, dynamic> _$PairingPayloadToJson(PairingPayload instance) =>
    <String, dynamic>{
      'lanUrls': instance.lanUrls,
      'tlsPort': instance.tlsPort,
      'certFingerprint': instance.certFingerprint,
      'code': instance.code,
      'expiresAt': instance.expiresAt,
    };
