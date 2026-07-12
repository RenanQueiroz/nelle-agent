// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'models.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Models _$ModelsFromJson(Map<String, dynamic> json) => Models(
  available: (json['available'] as List<dynamic>)
      .map((e) => ModelListItem.fromJson(e as Map<String, dynamic>))
      .toList(),
  selectedModelId: json['selectedModelId'] as String?,
  defaultModelId: json['defaultModelId'] as String?,
);

Map<String, dynamic> _$ModelsToJson(Models instance) => <String, dynamic>{
  'selectedModelId': instance.selectedModelId,
  'defaultModelId': instance.defaultModelId,
  'available': instance.available,
};
