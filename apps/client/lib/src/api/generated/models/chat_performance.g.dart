// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'chat_performance.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ChatPerformance _$ChatPerformanceFromJson(Map<String, dynamic> json) =>
    ChatPerformance(
      source: ChatPerformanceSource.fromJson(json['source'] as String),
      prompt: json['prompt'] == null
          ? null
          : Prompt.fromJson(json['prompt'] as Map<String, dynamic>),
      generation: json['generation'] == null
          ? null
          : Generation.fromJson(json['generation'] as Map<String, dynamic>),
      tokensPerSecond: json['tokensPerSecond'] as num?,
      generatedTokens: json['generatedTokens'] as num?,
    );

Map<String, dynamic> _$ChatPerformanceToJson(ChatPerformance instance) =>
    <String, dynamic>{
      'source': instance.source,
      'prompt': instance.prompt,
      'generation': instance.generation,
      'tokensPerSecond': instance.tokensPerSecond,
      'generatedTokens': instance.generatedTokens,
    };
