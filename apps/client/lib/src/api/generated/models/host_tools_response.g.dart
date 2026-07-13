// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'host_tools_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HostToolsResponse _$HostToolsResponseFromJson(Map<String, dynamic> json) =>
    HostToolsResponse(
      hostTools: HostTools.fromJson(json['hostTools'] as Map<String, dynamic>),
      warning: json['warning'] as String,
      description: json['description'] as String,
    );

Map<String, dynamic> _$HostToolsResponseToJson(HostToolsResponse instance) =>
    <String, dynamic>{
      'hostTools': instance.hostTools,
      'warning': instance.warning,
      'description': instance.description,
    };
