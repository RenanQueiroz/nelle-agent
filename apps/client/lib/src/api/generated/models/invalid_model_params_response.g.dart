// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'invalid_model_params_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

InvalidModelParamsResponse _$InvalidModelParamsResponseFromJson(
  Map<String, dynamic> json,
) => InvalidModelParamsResponse(
  error: NelleError.fromJson(json['error'] as Map<String, dynamic>),
  invalidParams: (json['invalidParams'] as List<dynamic>)
      .map((e) => InvalidModelParam.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$InvalidModelParamsResponseToJson(
  InvalidModelParamsResponse instance,
) => <String, dynamic>{
  'error': instance.error,
  'invalidParams': instance.invalidParams,
};
