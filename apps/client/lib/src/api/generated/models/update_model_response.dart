// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'configured_model.dart';
import 'model_catalog.dart';
import 'model_param_warning.dart';

part 'update_model_response.g.dart';

@JsonSerializable()
class UpdateModelResponse {
  const UpdateModelResponse({
    required this.model,
    required this.catalog,
    this.warnings,
  });

  factory UpdateModelResponse.fromJson(Map<String, Object?> json) =>
      _$UpdateModelResponseFromJson(json);

  final ConfiguredModel model;
  final ModelCatalog catalog;
  final List<ModelParamWarning>? warnings;

  Map<String, Object?> toJson() => _$UpdateModelResponseToJson(this);
}
