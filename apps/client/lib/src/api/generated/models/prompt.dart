// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'prompt.g.dart';

@JsonSerializable()
class Prompt {
  const Prompt({
    required this.tokens,
    this.tokensPerSecond,
    this.milliseconds,
    this.totalTokens,
    this.cacheTokens,
  });

  factory Prompt.fromJson(Map<String, Object?> json) => _$PromptFromJson(json);

  final num tokens;
  final num? tokensPerSecond;
  final num? milliseconds;
  final num? totalTokens;
  final num? cacheTokens;

  Map<String, Object?> toJson() => _$PromptToJson(this);
}
