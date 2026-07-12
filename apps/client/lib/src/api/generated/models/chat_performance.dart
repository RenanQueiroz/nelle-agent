// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'chat_performance_source.dart';
import 'generation.dart';
import 'prompt.dart';

part 'chat_performance.g.dart';

@JsonSerializable()
class ChatPerformance {
  const ChatPerformance({
    required this.source,
    this.prompt,
    this.generation,
    this.tokensPerSecond,
    this.generatedTokens,
  });

  factory ChatPerformance.fromJson(Map<String, Object?> json) =>
      _$ChatPerformanceFromJson(json);

  final ChatPerformanceSource source;
  final Prompt? prompt;
  final Generation? generation;
  final num? tokensPerSecond;
  final num? generatedTokens;

  Map<String, Object?> toJson() => _$ChatPerformanceToJson(this);
}
