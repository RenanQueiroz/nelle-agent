// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'configured_model.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConfiguredModel _$ConfiguredModelFromJson(Map<String, dynamic> json) =>
    ConfiguredModel(
      id: json['id'] as String,
      name: json['name'] as String,
      presetName: json['presetName'] as String,
      source: json['source'] as String,
      pinned: json['pinned'] as bool,
      params: ModelParams.fromJson(json['params'] as Map<String, dynamic>),
      createdAt: json['createdAt'] as String,
      repoId: json['repoId'] as String?,
      quant: json['quant'] as String?,
      hfRef: json['hfRef'] as String?,
    );

Map<String, dynamic> _$ConfiguredModelToJson(ConfiguredModel instance) =>
    <String, dynamic>{
      'id': instance.id,
      'name': instance.name,
      'presetName': instance.presetName,
      'source': instance.source,
      'repoId': instance.repoId,
      'quant': instance.quant,
      'hfRef': instance.hfRef,
      'pinned': instance.pinned,
      'params': instance.params,
      'createdAt': instance.createdAt,
    };
