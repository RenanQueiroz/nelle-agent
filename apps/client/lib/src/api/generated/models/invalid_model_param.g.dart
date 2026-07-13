// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invalid_model_param.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvalidModelParam _$InvalidModelParamFromJson(Map<String, dynamic> json) =>
    InvalidModelParam(
      key: json['key'] as String,
      reason: InvalidModelParamReason.fromJson(json['reason'] as String),
      message: json['message'] as String,
      suggestion: json['suggestion'] as String?,
    );

Map<String, dynamic> _$InvalidModelParamToJson(InvalidModelParam instance) =>
    <String, dynamic>{
      'key': instance.key,
      'reason': instance.reason,
      'message': instance.message,
      'suggestion': instance.suggestion,
    };
