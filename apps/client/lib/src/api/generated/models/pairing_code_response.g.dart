// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'pairing_code_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PairingCodeResponse _$PairingCodeResponseFromJson(Map<String, dynamic> json) =>
    PairingCodeResponse(
      code: json['code'] as String,
      expiresAt: json['expiresAt'] as String,
      qrPayload: PairingPayload.fromJson(
        json['qrPayload'] as Map<String, dynamic>,
      ),
    );

Map<String, dynamic> _$PairingCodeResponseToJson(
  PairingCodeResponse instance,
) => <String, dynamic>{
  'code': instance.code,
  'expiresAt': instance.expiresAt,
  'qrPayload': instance.qrPayload,
};
