// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'chat_message.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ChatMessage _$ChatMessageFromJson(Map<String, dynamic> json) => ChatMessage(
  id: json['id'] as String,
  role: ChatMessageRole.fromJson(json['role'] as String),
  content: json['content'] as String,
  createdAt: json['createdAt'] as String,
  attachments: (json['attachments'] as List<dynamic>?)
      ?.map((e) => AttachmentMetadata.fromJson(e as Map<String, dynamic>))
      .toList(),
  modelId: json['modelId'] as String?,
  modelRuntimeId: json['modelRuntimeId'] as String?,
  modelAliasSnapshot: json['modelAliasSnapshot'] as String?,
  regeneratesPiEntryId: json['regeneratesPiEntryId'] as String?,
  displayGroupId: json['displayGroupId'] as String?,
  performance: json['performance'] == null
      ? null
      : ChatPerformance.fromJson(json['performance'] as Map<String, dynamic>),
  toolCalls: (json['toolCalls'] as List<dynamic>?)
      ?.map((e) => ToolCallEvent.fromJson(e as Map<String, dynamic>))
      .toList(),
  reasoning: json['reasoning'] as String?,
);

Map<String, dynamic> _$ChatMessageToJson(ChatMessage instance) =>
    <String, dynamic>{
      'id': instance.id,
      'role': instance.role,
      'content': instance.content,
      'createdAt': instance.createdAt,
      'attachments': instance.attachments,
      'modelId': instance.modelId,
      'modelRuntimeId': instance.modelRuntimeId,
      'modelAliasSnapshot': instance.modelAliasSnapshot,
      'regeneratesPiEntryId': instance.regeneratesPiEntryId,
      'displayGroupId': instance.displayGroupId,
      'performance': instance.performance,
      'toolCalls': instance.toolCalls,
      'reasoning': instance.reasoning,
    };
