// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'update_model_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

UpdateModelResponse _$UpdateModelResponseFromJson(Map<String, dynamic> json) =>
    UpdateModelResponse(
      model: ConfiguredModel.fromJson(json['model'] as Map<String, dynamic>),
      catalog: ModelCatalog.fromJson(json['catalog'] as Map<String, dynamic>),
      warnings: (json['warnings'] as List<dynamic>?)
          ?.map((e) => ModelParamWarning.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$UpdateModelResponseToJson(
  UpdateModelResponse instance,
) => <String, dynamic>{
  'model': instance.model,
  'catalog': instance.catalog,
  'warnings': instance.warnings,
};
