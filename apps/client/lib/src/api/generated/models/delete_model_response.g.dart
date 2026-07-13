// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'delete_model_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

DeleteModelResponse _$DeleteModelResponseFromJson(Map<String, dynamic> json) =>
    DeleteModelResponse(
      ok: json['ok'] as bool,
      removedModelId: json['removedModelId'] as String,
      catalog: ModelCatalog.fromJson(json['catalog'] as Map<String, dynamic>),
      weightsRemoved: json['weightsRemoved'] as bool,
      reclaimedBytes: json['reclaimedBytes'] as num,
      sharedWithModelIds: (json['sharedWithModelIds'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
    );

Map<String, dynamic> _$DeleteModelResponseToJson(
  DeleteModelResponse instance,
) => <String, dynamic>{
  'ok': instance.ok,
  'removedModelId': instance.removedModelId,
  'catalog': instance.catalog,
  'weightsRemoved': instance.weightsRemoved,
  'reclaimedBytes': instance.reclaimedBytes,
  'sharedWithModelIds': instance.sharedWithModelIds,
};
