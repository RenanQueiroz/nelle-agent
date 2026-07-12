// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'chat_attachment_input.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ChatAttachmentInput _$ChatAttachmentInputFromJson(Map<String, dynamic> json) =>
    ChatAttachmentInput(
      id: json['id'] as String,
      kind: ChatAttachmentInputKind.fromJson(json['kind'] as String),
      name: json['name'] as String,
      mimeType: json['mimeType'] as String?,
      sizeBytes: (json['sizeBytes'] as num?)?.toInt(),
      text: json['text'] as String?,
      data: json['data'] as String?,
    );

Map<String, dynamic> _$ChatAttachmentInputToJson(
  ChatAttachmentInput instance,
) => <String, dynamic>{
  'id': instance.id,
  'kind': instance.kind,
  'name': instance.name,
  'mimeType': instance.mimeType,
  'sizeBytes': instance.sizeBytes,
  'text': instance.text,
  'data': instance.data,
};
