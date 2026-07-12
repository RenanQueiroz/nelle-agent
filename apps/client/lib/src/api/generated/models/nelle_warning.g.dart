// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'nelle_warning.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

NelleWarning _$NelleWarningFromJson(Map<String, dynamic> json) => NelleWarning(
  code: json['code'] as String,
  message: json['message'] as String,
  detail: json['detail'] as String?,
);

Map<String, dynamic> _$NelleWarningToJson(NelleWarning instance) =>
    <String, dynamic>{
      'code': instance.code,
      'message': instance.message,
      'detail': instance.detail,
    };
