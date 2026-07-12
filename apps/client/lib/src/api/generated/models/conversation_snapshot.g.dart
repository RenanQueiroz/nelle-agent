// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_snapshot.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationSnapshot _$ConversationSnapshotFromJson(
  Map<String, dynamic> json,
) => ConversationSnapshot(
  conversation: Conversation.fromJson(
    json['conversation'] as Map<String, dynamic>,
  ),
  entries: (json['entries'] as List<dynamic>)
      .map(
        (e) => ConversationEntryProjection.fromJson(e as Map<String, dynamic>),
      )
      .toList(),
  messages: (json['messages'] as List<dynamic>)
      .map((e) => ConversationMessage.fromJson(e as Map<String, dynamic>))
      .toList(),
  activePathEntryIds: (json['activePathEntryIds'] as List<dynamic>)
      .map((e) => e as String)
      .toList(),
  attachments: (json['attachments'] as List<dynamic>)
      .map((e) => AttachmentMetadata.fromJson(e as Map<String, dynamic>))
      .toList(),
  context: ConversationContextUsage.fromJson(
    json['context'] as Map<String, dynamic>,
  ),
  models: Models.fromJson(json['models'] as Map<String, dynamic>),
  capabilities: Capabilities.fromJson(
    json['capabilities'] as Map<String, dynamic>,
  ),
  errors: (json['errors'] as List<dynamic>)
      .map((e) => NelleError.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$ConversationSnapshotToJson(
  ConversationSnapshot instance,
) => <String, dynamic>{
  'conversation': instance.conversation,
  'entries': instance.entries,
  'messages': instance.messages,
  'activePathEntryIds': instance.activePathEntryIds,
  'attachments': instance.attachments,
  'context': instance.context,
  'models': instance.models,
  'capabilities': instance.capabilities,
  'errors': instance.errors,
};
