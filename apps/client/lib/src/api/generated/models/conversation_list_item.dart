// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_list_item_title_source.dart';
import 'conversation_status.dart';

part 'conversation_list_item.g.dart';

@JsonSerializable()
class ConversationListItem {
  const ConversationListItem({
    required this.id,
    required this.title,
    required this.titleSource,
    required this.pinned,
    required this.status,
    required this.updatedAt,
    this.defaultModelId,
  });
  
  factory ConversationListItem.fromJson(Map<String, Object?> json) => _$ConversationListItemFromJson(json);
  
  final String id;
  final String title;
  final ConversationListItemTitleSource titleSource;
  final bool pinned;
  final ConversationStatus status;
  final String updatedAt;
  final String? defaultModelId;

  Map<String, Object?> toJson() => _$ConversationListItemToJson(this);
}
