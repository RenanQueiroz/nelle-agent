// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'model_param_warning.g.dart';

@JsonSerializable()
class ModelParamWarning {
  const ModelParamWarning({required this.key, required this.message});

  factory ModelParamWarning.fromJson(Map<String, Object?> json) =>
      _$ModelParamWarningFromJson(json);

  final String key;
  final String message;

  Map<String, Object?> toJson() => _$ModelParamWarningToJson(this);
}
