// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_entry_projection.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationEntryProjection _$ConversationEntryProjectionFromJson(
  Map<String, dynamic> json,
) => ConversationEntryProjection(
  conversationId: json['conversationId'] as String,
  piEntryId: json['piEntryId'] as String,
  entryType: json['entryType'] as String,
  createdAt: json['createdAt'] as String,
  parentPiEntryId: json['parentPiEntryId'] as String?,
  role: json['role'] == null
      ? null
      : ConversationEntryProjectionRole.fromJson(json['role'] as String),
  textPreview: json['textPreview'] as String?,
  modelId: json['modelId'] as String?,
  modelRuntimeId: json['modelRuntimeId'] as String?,
  modelAliasSnapshot: json['modelAliasSnapshot'] as String?,
  performance: json['performance'],
  toolCalls: json['toolCalls'],
  attachmentSummary: json['attachmentSummary'],
  regeneratesPiEntryId: json['regeneratesPiEntryId'] as String?,
  displayGroupId: json['displayGroupId'] as String?,
  reasoning: json['reasoning'] as String?,
);

Map<String, dynamic> _$ConversationEntryProjectionToJson(
  ConversationEntryProjection instance,
) => <String, dynamic>{
  'conversationId': instance.conversationId,
  'piEntryId': instance.piEntryId,
  'parentPiEntryId': instance.parentPiEntryId,
  'entryType': instance.entryType,
  'role': instance.role,
  'textPreview': instance.textPreview,
  'createdAt': instance.createdAt,
  'modelId': instance.modelId,
  'modelRuntimeId': instance.modelRuntimeId,
  'modelAliasSnapshot': instance.modelAliasSnapshot,
  'performance': instance.performance,
  'toolCalls': instance.toolCalls,
  'attachmentSummary': instance.attachmentSummary,
  'regeneratesPiEntryId': instance.regeneratesPiEntryId,
  'displayGroupId': instance.displayGroupId,
  'reasoning': instance.reasoning,
};
