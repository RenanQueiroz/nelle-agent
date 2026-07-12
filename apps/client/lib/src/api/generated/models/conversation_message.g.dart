// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_message.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationMessage _$ConversationMessageFromJson(Map<String, dynamic> json) =>
    ConversationMessage(
      id: json['id'] as String,
      role: ConversationMessageRole.fromJson(json['role'] as String),
      content: json['content'] as String,
      createdAt: json['createdAt'] as String,
      parentPiEntryId: json['parentPiEntryId'] as String?,
      modelId: json['modelId'] as String?,
      modelRuntimeId: json['modelRuntimeId'] as String?,
      modelAliasSnapshot: json['modelAliasSnapshot'] as String?,
      regeneratesPiEntryId: json['regeneratesPiEntryId'] as String?,
      displayGroupId: json['displayGroupId'] as String?,
      variantLabel: json['variantLabel'] as String?,
      performance: json['performance'],
      toolCalls: json['toolCalls'],
      reasoning: json['reasoning'] as String?,
      attachments: (json['attachments'] as List<dynamic>?)
          ?.map((e) => AttachmentMetadata.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$ConversationMessageToJson(
  ConversationMessage instance,
) => <String, dynamic>{
  'id': instance.id,
  'role': instance.role,
  'content': instance.content,
  'createdAt': instance.createdAt,
  'parentPiEntryId': instance.parentPiEntryId,
  'modelId': instance.modelId,
  'modelRuntimeId': instance.modelRuntimeId,
  'modelAliasSnapshot': instance.modelAliasSnapshot,
  'regeneratesPiEntryId': instance.regeneratesPiEntryId,
  'displayGroupId': instance.displayGroupId,
  'variantLabel': instance.variantLabel,
  'performance': instance.performance,
  'toolCalls': instance.toolCalls,
  'reasoning': instance.reasoning,
  'attachments': instance.attachments,
};
