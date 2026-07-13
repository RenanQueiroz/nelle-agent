// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'invalid_model_param.dart';
import 'nelle_error.dart';

part 'invalid_model_params_response.g.dart';

@JsonSerializable()
class InvalidModelParamsResponse {
  const InvalidModelParamsResponse({
    required this.error,
    required this.invalidParams,
  });

  factory InvalidModelParamsResponse.fromJson(Map<String, Object?> json) =>
      _$InvalidModelParamsResponseFromJson(json);

  final NelleError error;
  final List<InvalidModelParam> invalidParams;

  Map<String, Object?> toJson() => _$InvalidModelParamsResponseToJson(this);
}
