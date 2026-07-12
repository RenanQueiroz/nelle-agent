// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'conversation_context_usage_source.dart';
import 'conversation_context_usage_status.dart';

part 'conversation_context_usage.g.dart';

@JsonSerializable()
class ConversationContextUsage {
  const ConversationContextUsage({
    this.usedTokens,
    this.totalTokens,
    this.source,
    this.status,
    this.updatedAt,
  });

  factory ConversationContextUsage.fromJson(Map<String, Object?> json) =>
      _$ConversationContextUsageFromJson(json);

  final int? usedTokens;
  final int? totalTokens;
  final ConversationContextUsageSource? source;
  final ConversationContextUsageStatus? status;
  final String? updatedAt;

  Map<String, Object?> toJson() => _$ConversationContextUsageToJson(this);
}
