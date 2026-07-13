// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'runtime_log_tail.g.dart';

@JsonSerializable()
class RuntimeLogTail {
  const RuntimeLogTail({required this.path, required this.text});

  factory RuntimeLogTail.fromJson(Map<String, Object?> json) =>
      _$RuntimeLogTailFromJson(json);

  final String path;
  final String text;

  Map<String, Object?> toJson() => _$RuntimeLogTailToJson(this);
}
