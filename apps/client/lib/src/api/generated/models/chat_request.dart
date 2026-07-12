// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'attachments.dart';

part 'chat_request.g.dart';

@JsonSerializable()
class ChatRequest {
  const ChatRequest({required this.message, this.attachments});

  factory ChatRequest.fromJson(Map<String, Object?> json) =>
      _$ChatRequestFromJson(json);

  final String message;
  final List<Attachments>? attachments;

  Map<String, Object?> toJson() => _$ChatRequestToJson(this);
}
