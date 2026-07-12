// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attachment_metadata_kind.dart';

part 'attachment_metadata.g.dart';

@JsonSerializable()
class AttachmentMetadata {
  const AttachmentMetadata({
    required this.id,
    required this.conversationId,
    required this.kind,
    required this.name,
    required this.createdAt,
    this.piEntryId,
    this.uploadId,
    this.mimeType,
    this.sizeBytes,
    this.storagePath,
    this.textPreview,
    this.processing,
  });
  
  factory AttachmentMetadata.fromJson(Map<String, Object?> json) => _$AttachmentMetadataFromJson(json);
  
  final String id;
  final String conversationId;
  final String? piEntryId;
  final String? uploadId;
  final AttachmentMetadataKind kind;
  final String name;
  final String? mimeType;
  final int? sizeBytes;
  final String? storagePath;
  final String? textPreview;
  final dynamic processing;
  final String createdAt;

  Map<String, Object?> toJson() => _$AttachmentMetadataToJson(this);
}
