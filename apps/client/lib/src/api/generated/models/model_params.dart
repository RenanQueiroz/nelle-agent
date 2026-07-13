// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'model_params.g.dart';

@JsonSerializable()
class ModelParams {
  const ModelParams({required this.extra, this.contextSize});

  factory ModelParams.fromJson(Map<String, Object?> json) =>
      _$ModelParamsFromJson(json);

  final num? contextSize;
  final Map<String, String> extra;

  Map<String, Object?> toJson() => _$ModelParamsToJson(this);
}
