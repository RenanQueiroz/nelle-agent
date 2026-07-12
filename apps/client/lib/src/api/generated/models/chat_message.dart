// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attachment_metadata.dart';
import 'chat_message_role.dart';
import 'chat_performance.dart';
import 'tool_call_event.dart';

part 'chat_message.g.dart';

@JsonSerializable()
class ChatMessage {
  const ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.createdAt,
    this.attachments,
    this.modelId,
    this.modelRuntimeId,
    this.modelAliasSnapshot,
    this.regeneratesPiEntryId,
    this.displayGroupId,
    this.performance,
    this.toolCalls,
    this.reasoning,
  });

  factory ChatMessage.fromJson(Map<String, Object?> json) =>
      _$ChatMessageFromJson(json);

  final String id;
  final ChatMessageRole role;
  final String content;
  final String createdAt;
  final List<AttachmentMetadata>? attachments;
  final String? modelId;
  final String? modelRuntimeId;
  final String? modelAliasSnapshot;
  final String? regeneratesPiEntryId;
  final String? displayGroupId;
  final ChatPerformance? performance;
  final List<ToolCallEvent>? toolCalls;
  final String? reasoning;

  Map<String, Object?> toJson() => _$ChatMessageToJson(this);
}
