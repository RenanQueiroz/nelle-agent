// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attachment_metadata.dart';
import 'conversation_message_role.dart';

part 'conversation_message.g.dart';

@JsonSerializable()
class ConversationMessage {
  const ConversationMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.createdAt,
    this.parentPiEntryId,
    this.modelId,
    this.modelRuntimeId,
    this.modelAliasSnapshot,
    this.regeneratesPiEntryId,
    this.displayGroupId,
    this.variantLabel,
    this.performance,
    this.toolCalls,
    this.reasoning,
    this.attachments,
  });
  
  factory ConversationMessage.fromJson(Map<String, Object?> json) => _$ConversationMessageFromJson(json);
  
  final String id;
  final ConversationMessageRole role;
  final String content;
  final String createdAt;
  final String? parentPiEntryId;
  final String? modelId;
  final String? modelRuntimeId;
  final String? modelAliasSnapshot;
  final String? regeneratesPiEntryId;
  final String? displayGroupId;
  final String? variantLabel;
  final dynamic performance;
  final dynamic toolCalls;
  final String? reasoning;
  final List<AttachmentMetadata>? attachments;

  Map<String, Object?> toJson() => _$ConversationMessageToJson(this);
}
