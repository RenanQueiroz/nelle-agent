// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'generation.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Generation _$GenerationFromJson(Map<String, dynamic> json) => Generation(
  tokens: json['tokens'] as num,
  tokensPerSecond: json['tokensPerSecond'] as num?,
  milliseconds: json['milliseconds'] as num?,
  totalTokens: json['totalTokens'] as num?,
  cacheTokens: json['cacheTokens'] as num?,
);

Map<String, dynamic> _$GenerationToJson(Generation instance) =>
    <String, dynamic>{
      'tokens': instance.tokens,
      'tokensPerSecond': instance.tokensPerSecond,
      'milliseconds': instance.milliseconds,
      'totalTokens': instance.totalTokens,
      'cacheTokens': instance.cacheTokens,
    };
