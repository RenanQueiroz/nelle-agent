// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'llama_router_model.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LlamaRouterModel _$LlamaRouterModelFromJson(Map<String, dynamic> json) =>
    LlamaRouterModel(
      sectionId: json['sectionId'] as String,
      alias: json['alias'] as String,
      status: json['status'] as String,
      aliases: (json['aliases'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      routerModelId: json['routerModelId'] as String?,
      hfRepo: json['hfRepo'] as String?,
      progress: json['progress'] as num?,
      source: json['source'] as String?,
      canRemove: json['canRemove'] as bool?,
      architecture: json['architecture'] as String?,
      contextWindow: json['contextWindow'] as num?,
      contextTrain: json['contextTrain'] as num?,
      parameterCount: json['parameterCount'] as num?,
    );

Map<String, dynamic> _$LlamaRouterModelToJson(LlamaRouterModel instance) =>
    <String, dynamic>{
      'sectionId': instance.sectionId,
      'routerModelId': instance.routerModelId,
      'alias': instance.alias,
      'hfRepo': instance.hfRepo,
      'status': instance.status,
      'progress': instance.progress,
      'aliases': instance.aliases,
      'source': instance.source,
      'canRemove': instance.canRemove,
      'architecture': instance.architecture,
      'contextWindow': instance.contextWindow,
      'contextTrain': instance.contextTrain,
      'parameterCount': instance.parameterCount,
    };
