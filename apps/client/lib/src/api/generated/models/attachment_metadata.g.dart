// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'attachment_metadata.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

AttachmentMetadata _$AttachmentMetadataFromJson(Map<String, dynamic> json) =>
    AttachmentMetadata(
      id: json['id'] as String,
      conversationId: json['conversationId'] as String,
      kind: AttachmentMetadataKind.fromJson(json['kind'] as String),
      name: json['name'] as String,
      createdAt: json['createdAt'] as String,
      piEntryId: json['piEntryId'] as String?,
      uploadId: json['uploadId'] as String?,
      mimeType: json['mimeType'] as String?,
      sizeBytes: (json['sizeBytes'] as num?)?.toInt(),
      storagePath: json['storagePath'] as String?,
      textPreview: json['textPreview'] as String?,
      processing: json['processing'],
    );

Map<String, dynamic> _$AttachmentMetadataToJson(AttachmentMetadata instance) =>
    <String, dynamic>{
      'id': instance.id,
      'conversationId': instance.conversationId,
      'piEntryId': instance.piEntryId,
      'uploadId': instance.uploadId,
      'kind': instance.kind,
      'name': instance.name,
      'mimeType': instance.mimeType,
      'sizeBytes': instance.sizeBytes,
      'storagePath': instance.storagePath,
      'textPreview': instance.textPreview,
      'processing': instance.processing,
      'createdAt': instance.createdAt,
    };
