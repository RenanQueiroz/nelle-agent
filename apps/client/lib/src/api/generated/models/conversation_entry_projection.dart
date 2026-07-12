// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_entry_projection_role.dart';

part 'conversation_entry_projection.g.dart';

@JsonSerializable()
class ConversationEntryProjection {
  const ConversationEntryProjection({
    required this.conversationId,
    required this.piEntryId,
    required this.entryType,
    required this.createdAt,
    this.parentPiEntryId,
    this.role,
    this.textPreview,
    this.modelId,
    this.modelRuntimeId,
    this.modelAliasSnapshot,
    this.performance,
    this.toolCalls,
    this.attachmentSummary,
    this.regeneratesPiEntryId,
    this.displayGroupId,
    this.reasoning,
  });

  factory ConversationEntryProjection.fromJson(Map<String, Object?> json) =>
      _$ConversationEntryProjectionFromJson(json);

  final String conversationId;
  final String piEntryId;
  final String? parentPiEntryId;
  final String entryType;
  final ConversationEntryProjectionRole? role;
  final String? textPreview;
  final String createdAt;
  final String? modelId;
  final String? modelRuntimeId;
  final String? modelAliasSnapshot;
  final dynamic performance;
  final dynamic toolCalls;
  final dynamic attachmentSummary;
  final String? regeneratesPiEntryId;
  final String? displayGroupId;
  final String? reasoning;

  Map<String, Object?> toJson() => _$ConversationEntryProjectionToJson(this);
}
