// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_status.dart';

part 'conversation_diagnostics.g.dart';

@JsonSerializable()
class ConversationDiagnostics {
  const ConversationDiagnostics({
    required this.conversationId,
    required this.status,
    required this.exists,
    required this.projectionEntryCount,
    required this.attachmentCount,
    required this.toolAuditCount,
    this.piSessionPath,
    this.piSessionId,
    this.reason,
    this.sizeBytes,
  });

  factory ConversationDiagnostics.fromJson(Map<String, Object?> json) =>
      _$ConversationDiagnosticsFromJson(json);

  final String conversationId;
  final ConversationStatus status;
  final String? piSessionPath;
  final String? piSessionId;
  final bool exists;
  final String? reason;
  final int? sizeBytes;
  final int projectionEntryCount;
  final int attachmentCount;
  final int toolAuditCount;

  Map<String, Object?> toJson() => _$ConversationDiagnosticsToJson(this);
}
