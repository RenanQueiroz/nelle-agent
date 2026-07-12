// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_list_item.dart';

part 'conversation_list_response.g.dart';

@JsonSerializable()
class ConversationListResponse {
  const ConversationListResponse({
    required this.conversations,
    required this.total,
    this.nextCursor,
  });

  factory ConversationListResponse.fromJson(Map<String, Object?> json) =>
      _$ConversationListResponseFromJson(json);

  final List<ConversationListItem> conversations;
  final String? nextCursor;
  final int total;

  Map<String, Object?> toJson() => _$ConversationListResponseToJson(this);
}
