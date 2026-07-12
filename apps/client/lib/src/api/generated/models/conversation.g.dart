// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Conversation _$ConversationFromJson(Map<String, dynamic> json) => Conversation(
  id: json['id'] as String,
  title: json['title'] as String,
  titleSource: TitleSource.fromJson(json['titleSource'] as String),
  pinned: json['pinned'] as bool,
  status: ConversationStatus.fromJson(json['status'] as String),
  createdAt: json['createdAt'] as String,
  updatedAt: json['updatedAt'] as String,
  reasoningLevel: ReasoningLevel.fromJson(json['reasoningLevel'] as String),
  piSessionId: json['piSessionId'] as String?,
  activeLeafPiEntryId: json['activeLeafPiEntryId'] as String?,
  defaultModelId: json['defaultModelId'] as String?,
  parentConversationId: json['parentConversationId'] as String?,
  forkedFromPiEntryId: json['forkedFromPiEntryId'] as String?,
  forkKind: json['forkKind'] == null
      ? null
      : ForkKind.fromJson(json['forkKind'] as String),
  currentRun: json['currentRun'] == null
      ? null
      : CurrentRun.fromJson(json['currentRun'] as Map<String, dynamic>),
);

Map<String, dynamic> _$ConversationToJson(Conversation instance) =>
    <String, dynamic>{
      'id': instance.id,
      'title': instance.title,
      'titleSource': instance.titleSource,
      'pinned': instance.pinned,
      'status': instance.status,
      'createdAt': instance.createdAt,
      'updatedAt': instance.updatedAt,
      'piSessionId': instance.piSessionId,
      'activeLeafPiEntryId': instance.activeLeafPiEntryId,
      'defaultModelId': instance.defaultModelId,
      'parentConversationId': instance.parentConversationId,
      'forkedFromPiEntryId': instance.forkedFromPiEntryId,
      'forkKind': instance.forkKind,
      'reasoningLevel': instance.reasoningLevel,
      'currentRun': instance.currentRun,
    };
