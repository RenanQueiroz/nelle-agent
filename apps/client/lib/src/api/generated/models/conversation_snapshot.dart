// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attachment_metadata.dart';
import 'capabilities.dart';
import 'conversation.dart';
import 'conversation_context_usage.dart';
import 'conversation_entry_projection.dart';
import 'conversation_message.dart';
import 'models.dart';
import 'nelle_error.dart';

part 'conversation_snapshot.g.dart';

@JsonSerializable()
class ConversationSnapshot {
  const ConversationSnapshot({
    required this.conversation,
    required this.entries,
    required this.messages,
    required this.activePathEntryIds,
    required this.attachments,
    required this.context,
    required this.models,
    required this.capabilities,
    required this.errors,
  });

  factory ConversationSnapshot.fromJson(Map<String, Object?> json) =>
      _$ConversationSnapshotFromJson(json);

  final Conversation conversation;
  final List<ConversationEntryProjection> entries;
  final List<ConversationMessage> messages;
  final List<String> activePathEntryIds;
  final List<AttachmentMetadata> attachments;
  final ConversationContextUsage context;
  final Models models;
  final Capabilities capabilities;
  final List<NelleError> errors;

  Map<String, Object?> toJson() => _$ConversationSnapshotToJson(this);
}
