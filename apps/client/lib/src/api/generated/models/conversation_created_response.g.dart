// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_created_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationCreatedResponse _$ConversationCreatedResponseFromJson(
  Map<String, dynamic> json,
) => ConversationCreatedResponse(
  conversation: ConversationListItem.fromJson(
    json['conversation'] as Map<String, dynamic>,
  ),
  snapshot: ConversationSnapshot.fromJson(
    json['snapshot'] as Map<String, dynamic>,
  ),
);

Map<String, dynamic> _$ConversationCreatedResponseToJson(
  ConversationCreatedResponse instance,
) => <String, dynamic>{
  'conversation': instance.conversation,
  'snapshot': instance.snapshot,
};
