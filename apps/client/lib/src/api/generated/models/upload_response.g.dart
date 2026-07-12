// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'upload_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

UploadResponse _$UploadResponseFromJson(Map<String, dynamic> json) =>
    UploadResponse(
      uploadId: json['uploadId'] as String,
      kind: UploadResponseKind.fromJson(json['kind'] as String),
      name: json['name'] as String,
      sizeBytes: (json['sizeBytes'] as num).toInt(),
      warnings: (json['warnings'] as List<dynamic>)
          .map((e) => e as String)
          .toList(),
      mimeType: json['mimeType'] as String?,
      textPreview: json['textPreview'] as String?,
      pageCount: (json['pageCount'] as num?)?.toInt(),
      hasTextLayer: json['hasTextLayer'] as bool?,
    );

Map<String, dynamic> _$UploadResponseToJson(UploadResponse instance) =>
    <String, dynamic>{
      'uploadId': instance.uploadId,
      'kind': instance.kind,
      'name': instance.name,
      'mimeType': instance.mimeType,
      'sizeBytes': instance.sizeBytes,
      'textPreview': instance.textPreview,
      'pageCount': instance.pageCount,
      'hasTextLayer': instance.hasTextLayer,
      'warnings': instance.warnings,
    };
