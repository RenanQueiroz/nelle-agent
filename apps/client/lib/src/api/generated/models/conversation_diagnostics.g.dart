// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_diagnostics.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationDiagnostics _$ConversationDiagnosticsFromJson(
  Map<String, dynamic> json,
) => ConversationDiagnostics(
  conversationId: json['conversationId'] as String,
  status: ConversationStatus.fromJson(json['status'] as String),
  exists: json['exists'] as bool,
  projectionEntryCount: (json['projectionEntryCount'] as num).toInt(),
  attachmentCount: (json['attachmentCount'] as num).toInt(),
  toolAuditCount: (json['toolAuditCount'] as num).toInt(),
  piSessionPath: json['piSessionPath'] as String?,
  piSessionId: json['piSessionId'] as String?,
  reason: json['reason'] as String?,
  sizeBytes: (json['sizeBytes'] as num?)?.toInt(),
);

Map<String, dynamic> _$ConversationDiagnosticsToJson(
  ConversationDiagnostics instance,
) => <String, dynamic>{
  'conversationId': instance.conversationId,
  'status': instance.status,
  'piSessionPath': instance.piSessionPath,
  'piSessionId': instance.piSessionId,
  'exists': instance.exists,
  'reason': instance.reason,
  'sizeBytes': instance.sizeBytes,
  'projectionEntryCount': instance.projectionEntryCount,
  'attachmentCount': instance.attachmentCount,
  'toolAuditCount': instance.toolAuditCount,
};
