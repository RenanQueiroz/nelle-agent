// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'model_catalog.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ModelCatalog _$ModelCatalogFromJson(Map<String, dynamic> json) => ModelCatalog(
  models: (json['models'] as List<dynamic>)
      .map((e) => ConfiguredModel.fromJson(e as Map<String, dynamic>))
      .toList(),
  activeModelId: json['activeModelId'] as String?,
  globalModelParams: Map<String, String>.from(json['globalModelParams'] as Map),
);

Map<String, dynamic> _$ModelCatalogToJson(ModelCatalog instance) =>
    <String, dynamic>{
      'models': instance.models,
      'activeModelId': instance.activeModelId,
      'globalModelParams': instance.globalModelParams,
    };
