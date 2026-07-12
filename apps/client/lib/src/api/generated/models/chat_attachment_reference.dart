// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'chat_attachment_reference.g.dart';

@JsonSerializable()
class ChatAttachmentReference {
  const ChatAttachmentReference({required this.uploadId});

  factory ChatAttachmentReference.fromJson(Map<String, Object?> json) =>
      _$ChatAttachmentReferenceFromJson(json);

  final String uploadId;

  Map<String, Object?> toJson() => _$ChatAttachmentReferenceToJson(this);
}
