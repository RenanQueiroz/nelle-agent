// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'llama_router_model.dart';

part 'llama_models_response.g.dart';

@JsonSerializable()
class LlamaModelsResponse {
  const LlamaModelsResponse({
    required this.models,
  });
  
  factory LlamaModelsResponse.fromJson(Map<String, Object?> json) => _$LlamaModelsResponseFromJson(json);
  
  final List<LlamaRouterModel> models;

  Map<String, Object?> toJson() => _$LlamaModelsResponseToJson(this);
}
