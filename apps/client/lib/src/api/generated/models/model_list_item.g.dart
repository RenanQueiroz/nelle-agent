// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'model_list_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ModelListItem _$ModelListItemFromJson(Map<String, dynamic> json) =>
    ModelListItem(
      id: json['id'] as String,
      alias: json['alias'] as String,
      status: json['status'] as String?,
    );

Map<String, dynamic> _$ModelListItemToJson(ModelListItem instance) =>
    <String, dynamic>{
      'id': instance.id,
      'alias': instance.alias,
      'status': instance.status,
    };
