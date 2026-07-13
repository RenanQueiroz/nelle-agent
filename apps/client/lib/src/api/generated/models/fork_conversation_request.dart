// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'fork_conversation_request.g.dart';

@JsonSerializable()
class ForkConversationRequest {
  const ForkConversationRequest({required this.entryId, this.title});

  factory ForkConversationRequest.fromJson(Map<String, Object?> json) =>
      _$ForkConversationRequestFromJson(json);

  final String entryId;
  final String? title;

  Map<String, Object?> toJson() => _$ForkConversationRequestToJson(this);
}
