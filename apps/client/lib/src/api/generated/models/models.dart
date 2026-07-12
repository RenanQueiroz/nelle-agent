// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'model_list_item.dart';

part 'models.g.dart';

@JsonSerializable()
class Models {
  const Models({
    required this.available,
    this.selectedModelId,
    this.defaultModelId,
  });

  factory Models.fromJson(Map<String, Object?> json) => _$ModelsFromJson(json);

  final String? selectedModelId;
  final String? defaultModelId;
  final List<ModelListItem> available;

  Map<String, Object?> toJson() => _$ModelsToJson(this);
}
