// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'invalid_model_param_reason.dart';

part 'invalid_model_param.g.dart';

@JsonSerializable()
class InvalidModelParam {
  const InvalidModelParam({
    required this.key,
    required this.reason,
    required this.message,
    this.suggestion,
  });

  factory InvalidModelParam.fromJson(Map<String, Object?> json) =>
      _$InvalidModelParamFromJson(json);

  final String key;
  final InvalidModelParamReason reason;
  final String message;
  final String? suggestion;

  Map<String, Object?> toJson() => _$InvalidModelParamToJson(this);
}
