// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'attachments.g.dart';

@JsonSerializable()
class Attachments {
  const Attachments({
    required this.uploadId,
  });
  
  factory Attachments.fromJson(Map<String, Object?> json) => _$AttachmentsFromJson(json);
  
  final String uploadId;

  Map<String, Object?> toJson() => _$AttachmentsToJson(this);
}
