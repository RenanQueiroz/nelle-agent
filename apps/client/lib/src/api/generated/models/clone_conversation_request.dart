// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'clone_conversation_request.g.dart';

@JsonSerializable()
class CloneConversationRequest {
  const CloneConversationRequest({this.entryId, this.title});

  factory CloneConversationRequest.fromJson(Map<String, Object?> json) =>
      _$CloneConversationRequestFromJson(json);

  final String? entryId;
  final String? title;

  Map<String, Object?> toJson() => _$CloneConversationRequestToJson(this);
}
