// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'model_list_item.g.dart';

@JsonSerializable()
class ModelListItem {
  const ModelListItem({
    required this.id,
    required this.alias,
    this.status,
  });
  
  factory ModelListItem.fromJson(Map<String, Object?> json) => _$ModelListItemFromJson(json);
  
  final String id;
  final String alias;
  final String? status;

  Map<String, Object?> toJson() => _$ModelListItemToJson(this);
}
