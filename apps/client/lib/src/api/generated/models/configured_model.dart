// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'model_params.dart';

part 'configured_model.g.dart';

@JsonSerializable()
class ConfiguredModel {
  const ConfiguredModel({
    required this.id,
    required this.name,
    required this.presetName,
    required this.source,
    required this.pinned,
    required this.diskBytes,
    required this.params,
    required this.createdAt,
    this.repoId,
    this.quant,
    this.hfRef,
    this.architecture,
    this.contextTrain,
    this.contextWindow,
    this.parameterCount,
  });

  factory ConfiguredModel.fromJson(Map<String, Object?> json) =>
      _$ConfiguredModelFromJson(json);

  final String id;
  final String name;
  final String presetName;
  final String source;
  final String? repoId;
  final String? quant;
  final String? hfRef;
  final bool pinned;
  final num? diskBytes;
  final String? architecture;
  final num? contextTrain;
  final num? contextWindow;
  final num? parameterCount;
  final ModelParams params;
  final String createdAt;

  Map<String, Object?> toJson() => _$ConfiguredModelToJson(this);
}
