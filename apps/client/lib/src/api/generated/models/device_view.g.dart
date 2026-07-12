// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'device_view.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeviceView _$DeviceViewFromJson(Map<String, dynamic> json) => DeviceView(
  id: json['id'] as String,
  name: json['name'] as String,
  platform: json['platform'] as String?,
  createdAt: json['createdAt'] as String,
  lastSeenAt: json['lastSeenAt'] as String?,
);

Map<String, dynamic> _$DeviceViewToJson(DeviceView instance) =>
    <String, dynamic>{
      'id': instance.id,
      'name': instance.name,
      'platform': instance.platform,
      'createdAt': instance.createdAt,
      'lastSeenAt': instance.lastSeenAt,
    };
