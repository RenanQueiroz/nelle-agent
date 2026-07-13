// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'host_tools.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HostTools _$HostToolsFromJson(Map<String, dynamic> json) => HostTools(
  enabled: json['enabled'] as bool,
  acknowledged: json['acknowledged'] as bool,
  updatedAt: json['updatedAt'] as String,
);

Map<String, dynamic> _$HostToolsToJson(HostTools instance) => <String, dynamic>{
  'enabled': instance.enabled,
  'acknowledged': instance.acknowledged,
  'updatedAt': instance.updatedAt,
};
