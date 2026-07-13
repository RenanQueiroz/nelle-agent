// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'llama_tokenize_result.g.dart';

@JsonSerializable()
class LlamaTokenizeResult {
  const LlamaTokenizeResult({required this.tokens});

  factory LlamaTokenizeResult.fromJson(Map<String, Object?> json) =>
      _$LlamaTokenizeResultFromJson(json);

  final num tokens;

  Map<String, Object?> toJson() => _$LlamaTokenizeResultToJson(this);
}
