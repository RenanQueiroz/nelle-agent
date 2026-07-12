// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_context_usage.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationContextUsage _$ConversationContextUsageFromJson(
  Map<String, dynamic> json,
) => ConversationContextUsage(
  usedTokens: (json['usedTokens'] as num?)?.toInt(),
  totalTokens: (json['totalTokens'] as num?)?.toInt(),
  source: json['source'] == null
      ? null
      : ConversationContextUsageSource.fromJson(json['source'] as String),
  status: json['status'] == null
      ? null
      : ConversationContextUsageStatus.fromJson(json['status'] as String),
  updatedAt: json['updatedAt'] as String?,
);

Map<String, dynamic> _$ConversationContextUsageToJson(
  ConversationContextUsage instance,
) => <String, dynamic>{
  'usedTokens': instance.usedTokens,
  'totalTokens': instance.totalTokens,
  'source': instance.source,
  'status': instance.status,
  'updatedAt': instance.updatedAt,
};
