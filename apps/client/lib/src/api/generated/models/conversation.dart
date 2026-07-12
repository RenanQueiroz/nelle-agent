// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'title_source.dart';
import 'conversation_status.dart';
import 'fork_kind.dart';
import 'reasoning_level.dart';
import 'current_run.dart';

part 'conversation.g.dart';

@JsonSerializable()
class Conversation {
  const Conversation({
    required this.id,
    required this.title,
    required this.titleSource,
    required this.pinned,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    required this.reasoningLevel,
    this.piSessionId,
    this.activeLeafPiEntryId,
    this.defaultModelId,
    this.parentConversationId,
    this.forkedFromPiEntryId,
    this.forkKind,
    this.currentRun,
  });
  
  factory Conversation.fromJson(Map<String, Object?> json) => _$ConversationFromJson(json);
  
  final String id;
  final String title;
  final TitleSource titleSource;
  final bool pinned;
  final ConversationStatus status;
  final String createdAt;
  final String updatedAt;
  final String? piSessionId;
  final String? activeLeafPiEntryId;
  final String? defaultModelId;
  final String? parentConversationId;
  final String? forkedFromPiEntryId;
  final ForkKind? forkKind;
  final ReasoningLevel reasoningLevel;
  final CurrentRun? currentRun;

  Map<String, Object?> toJson() => _$ConversationToJson(this);
}
