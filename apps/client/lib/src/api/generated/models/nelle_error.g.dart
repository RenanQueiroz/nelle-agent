// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'nelle_error.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

NelleError _$NelleErrorFromJson(Map<String, dynamic> json) => NelleError(
  code: json['code'] as String,
  message: json['message'] as String,
  detail: json['detail'] as String?,
  retryable: json['retryable'] as bool?,
  logRef: json['logRef'] as String?,
);

Map<String, dynamic> _$NelleErrorToJson(NelleError instance) =>
    <String, dynamic>{
      'code': instance.code,
      'message': instance.message,
      'detail': instance.detail,
      'retryable': instance.retryable,
      'logRef': instance.logRef,
    };
