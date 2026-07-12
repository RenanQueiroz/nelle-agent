// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'pair_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

PairRequest _$PairRequestFromJson(Map<String, dynamic> json) => PairRequest(
  code: json['code'] as String,
  deviceName: json['deviceName'] as String,
  platform: json['platform'] as String?,
);

Map<String, dynamic> _$PairRequestToJson(PairRequest instance) =>
    <String, dynamic>{
      'code': instance.code,
      'deviceName': instance.deviceName,
      'platform': instance.platform,
    };
