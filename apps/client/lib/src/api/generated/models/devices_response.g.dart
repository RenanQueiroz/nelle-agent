// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'devices_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DevicesResponse _$DevicesResponseFromJson(Map<String, dynamic> json) =>
    DevicesResponse(
      devices: (json['devices'] as List<dynamic>)
          .map((e) => DeviceView.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$DevicesResponseToJson(DevicesResponse instance) =>
    <String, dynamic>{'devices': instance.devices};
