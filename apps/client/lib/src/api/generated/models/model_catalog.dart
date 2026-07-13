// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'configured_model.dart';

part 'model_catalog.g.dart';

@JsonSerializable()
class ModelCatalog {
  const ModelCatalog({
    required this.models,
    required this.activeModelId,
    required this.globalModelParams,
  });

  factory ModelCatalog.fromJson(Map<String, Object?> json) =>
      _$ModelCatalogFromJson(json);

  final List<ConfiguredModel> models;
  final String? activeModelId;
  final Map<String, String> globalModelParams;

  Map<String, Object?> toJson() => _$ModelCatalogToJson(this);
}
