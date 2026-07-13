// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_list_item.dart';
import 'conversation_snapshot.dart';

part 'conversation_created_response.g.dart';

@JsonSerializable()
class ConversationCreatedResponse {
  const ConversationCreatedResponse({
    required this.conversation,
    required this.snapshot,
  });

  factory ConversationCreatedResponse.fromJson(Map<String, Object?> json) =>
      _$ConversationCreatedResponseFromJson(json);

  final ConversationListItem conversation;
  final ConversationSnapshot snapshot;

  Map<String, Object?> toJson() => _$ConversationCreatedResponseToJson(this);
}
