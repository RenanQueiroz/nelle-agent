// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'llama_models_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LlamaModelsResponse _$LlamaModelsResponseFromJson(Map<String, dynamic> json) =>
    LlamaModelsResponse(
      models: (json['models'] as List<dynamic>)
          .map((e) => LlamaRouterModel.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$LlamaModelsResponseToJson(
  LlamaModelsResponse instance,
) => <String, dynamic>{'models': instance.models};
