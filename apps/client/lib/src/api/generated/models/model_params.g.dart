// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'model_params.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ModelParams _$ModelParamsFromJson(Map<String, dynamic> json) => ModelParams(
  extra: Map<String, String>.from(json['extra'] as Map),
  contextSize: json['contextSize'] as num?,
);

Map<String, dynamic> _$ModelParamsToJson(ModelParams instance) =>
    <String, dynamic>{
      'contextSize': instance.contextSize,
      'extra': instance.extra,
    };
