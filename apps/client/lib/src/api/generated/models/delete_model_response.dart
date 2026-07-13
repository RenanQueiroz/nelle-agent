// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'model_catalog.dart';

part 'delete_model_response.g.dart';

@JsonSerializable()
class DeleteModelResponse {
  const DeleteModelResponse({
    required this.ok,
    required this.removedModelId,
    required this.catalog,
    required this.weightsRemoved,
    required this.reclaimedBytes,
    required this.sharedWithModelIds,
  });

  factory DeleteModelResponse.fromJson(Map<String, Object?> json) =>
      _$DeleteModelResponseFromJson(json);

  final bool ok;
  final String removedModelId;
  final ModelCatalog catalog;
  final bool weightsRemoved;
  final num reclaimedBytes;
  final List<String> sharedWithModelIds;

  Map<String, Object?> toJson() => _$DeleteModelResponseToJson(this);
}
