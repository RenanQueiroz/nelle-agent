// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'upload_response_kind.dart';

part 'upload_response.g.dart';

@JsonSerializable()
class UploadResponse {
  const UploadResponse({
    required this.uploadId,
    required this.kind,
    required this.name,
    required this.sizeBytes,
    required this.warnings,
    this.mimeType,
    this.textPreview,
    this.pageCount,
    this.hasTextLayer,
  });

  factory UploadResponse.fromJson(Map<String, Object?> json) =>
      _$UploadResponseFromJson(json);

  final String uploadId;
  final UploadResponseKind kind;
  final String name;
  final String? mimeType;
  final int sizeBytes;
  final String? textPreview;
  final int? pageCount;
  final bool? hasTextLayer;
  final List<String> warnings;

  Map<String, Object?> toJson() => _$UploadResponseToJson(this);
}
