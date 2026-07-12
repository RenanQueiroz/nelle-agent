// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'llama_router_model.g.dart';

@JsonSerializable()
class LlamaRouterModel {
  const LlamaRouterModel({
    required this.sectionId,
    required this.alias,
    required this.status,
    required this.aliases,
    this.routerModelId,
    this.hfRepo,
    this.progress,
    this.source,
    this.canRemove,
    this.architecture,
    this.contextWindow,
    this.contextTrain,
    this.parameterCount,
  });

  factory LlamaRouterModel.fromJson(Map<String, Object?> json) =>
      _$LlamaRouterModelFromJson(json);

  final String sectionId;
  final String? routerModelId;
  final String alias;
  final String? hfRepo;
  final String status;
  final num? progress;
  final List<String> aliases;
  final String? source;
  final bool? canRemove;
  final String? architecture;
  final num? contextWindow;
  final num? contextTrain;
  final num? parameterCount;

  Map<String, Object?> toJson() => _$LlamaRouterModelToJson(this);
}
