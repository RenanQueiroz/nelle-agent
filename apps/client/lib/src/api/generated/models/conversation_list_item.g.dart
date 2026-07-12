// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_list_item.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationListItem _$ConversationListItemFromJson(
  Map<String, dynamic> json,
) => ConversationListItem(
  id: json['id'] as String,
  title: json['title'] as String,
  titleSource: ConversationListItemTitleSource.fromJson(
    json['titleSource'] as String,
  ),
  pinned: json['pinned'] as bool,
  status: ConversationStatus.fromJson(json['status'] as String),
  updatedAt: json['updatedAt'] as String,
  defaultModelId: json['defaultModelId'] as String?,
);

Map<String, dynamic> _$ConversationListItemToJson(
  ConversationListItem instance,
) => <String, dynamic>{
  'id': instance.id,
  'title': instance.title,
  'titleSource': instance.titleSource,
  'pinned': instance.pinned,
  'status': instance.status,
  'updatedAt': instance.updatedAt,
  'defaultModelId': instance.defaultModelId,
};
