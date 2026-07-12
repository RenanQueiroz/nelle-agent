// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'current_run.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

CurrentRun _$CurrentRunFromJson(Map<String, dynamic> json) => CurrentRun(
  runId: json['runId'] as String,
  kind: Kind.fromJson(json['kind'] as String),
  startedAt: json['startedAt'] as String,
  status: ActiveRunStatus.fromJson(json['status'] as String),
  modelId: json['modelId'] as String?,
);

Map<String, dynamic> _$CurrentRunToJson(CurrentRun instance) =>
    <String, dynamic>{
      'runId': instance.runId,
      'kind': instance.kind,
      'modelId': instance.modelId,
      'startedAt': instance.startedAt,
      'status': instance.status,
    };
