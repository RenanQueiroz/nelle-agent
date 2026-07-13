// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'archive_conversation_ref.g.dart';

@JsonSerializable()
class ArchiveConversationRef {
  const ArchiveConversationRef({required this.id, required this.title});

  factory ArchiveConversationRef.fromJson(Map<String, Object?> json) =>
      _$ArchiveConversationRefFromJson(json);

  final String id;
  final String title;

  Map<String, Object?> toJson() => _$ArchiveConversationRefToJson(this);
}
