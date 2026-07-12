// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_list_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationListResponse _$ConversationListResponseFromJson(
  Map<String, dynamic> json,
) => ConversationListResponse(
  conversations: (json['conversations'] as List<dynamic>)
      .map((e) => ConversationListItem.fromJson(e as Map<String, dynamic>))
      .toList(),
  total: (json['total'] as num).toInt(),
  nextCursor: json['nextCursor'] as String?,
);

Map<String, dynamic> _$ConversationListResponseToJson(
  ConversationListResponse instance,
) => <String, dynamic>{
  'conversations': instance.conversations,
  'nextCursor': instance.nextCursor,
  'total': instance.total,
};
