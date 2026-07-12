// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'generation.g.dart';

@JsonSerializable()
class Generation {
  const Generation({
    required this.tokens,
    this.tokensPerSecond,
    this.milliseconds,
    this.totalTokens,
    this.cacheTokens,
  });

  factory Generation.fromJson(Map<String, Object?> json) =>
      _$GenerationFromJson(json);

  final num tokens;
  final num? tokensPerSecond;
  final num? milliseconds;
  final num? totalTokens;
  final num? cacheTokens;

  Map<String, Object?> toJson() => _$GenerationToJson(this);
}
