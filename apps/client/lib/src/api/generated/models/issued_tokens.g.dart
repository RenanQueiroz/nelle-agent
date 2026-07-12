// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'issued_tokens.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

IssuedTokens _$IssuedTokensFromJson(Map<String, dynamic> json) => IssuedTokens(
  deviceId: json['deviceId'] as String,
  accessToken: json['accessToken'] as String,
  accessExpiresAt: json['accessExpiresAt'] as String,
  refreshToken: json['refreshToken'] as String,
);

Map<String, dynamic> _$IssuedTokensToJson(IssuedTokens instance) =>
    <String, dynamic>{
      'deviceId': instance.deviceId,
      'accessToken': instance.accessToken,
      'accessExpiresAt': instance.accessExpiresAt,
      'refreshToken': instance.refreshToken,
    };
