// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'chat_attachment_input_kind.dart';

part 'chat_attachment_input.g.dart';

@JsonSerializable()
class ChatAttachmentInput {
  const ChatAttachmentInput({
    required this.id,
    required this.kind,
    required this.name,
    this.mimeType,
    this.sizeBytes,
    this.text,
    this.data,
  });

  factory ChatAttachmentInput.fromJson(Map<String, Object?> json) =>
      _$ChatAttachmentInputFromJson(json);

  final String id;
  final ChatAttachmentInputKind kind;
  final String name;
  final String? mimeType;
  final int? sizeBytes;
  final String? text;
  final String? data;

  Map<String, Object?> toJson() => _$ChatAttachmentInputToJson(this);
}
