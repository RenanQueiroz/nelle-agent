// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'llama_option.g.dart';

@JsonSerializable()
class LlamaOption {
  const LlamaOption({
    required this.keys,
    required this.env,
    required this.help,
    required this.section,
    this.valueHint,
  });

  factory LlamaOption.fromJson(Map<String, Object?> json) =>
      _$LlamaOptionFromJson(json);

  final List<String> keys;
  final List<String> env;
  final String? valueHint;
  final String help;
  final String section;

  Map<String, Object?> toJson() => _$LlamaOptionToJson(this);
}
