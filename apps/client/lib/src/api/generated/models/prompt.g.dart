// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'prompt.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Prompt _$PromptFromJson(Map<String, dynamic> json) => Prompt(
  tokens: json['tokens'] as num,
  tokensPerSecond: json['tokensPerSecond'] as num?,
  milliseconds: json['milliseconds'] as num?,
  totalTokens: json['totalTokens'] as num?,
  cacheTokens: json['cacheTokens'] as num?,
);

Map<String, dynamic> _$PromptToJson(Prompt instance) => <String, dynamic>{
  'tokens': instance.tokens,
  'tokensPerSecond': instance.tokensPerSecond,
  'milliseconds': instance.milliseconds,
  'totalTokens': instance.totalTokens,
  'cacheTokens': instance.cacheTokens,
};
