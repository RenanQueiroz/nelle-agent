// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'chat_request.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ChatRequest _$ChatRequestFromJson(Map<String, dynamic> json) => ChatRequest(
  message: json['message'] as String,
  attachments: (json['attachments'] as List<dynamic>?)
      ?.map((e) => Attachments.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$ChatRequestToJson(ChatRequest instance) =>
    <String, dynamic>{
      'message': instance.message,
      'attachments': instance.attachments,
    };
