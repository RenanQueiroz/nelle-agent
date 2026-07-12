// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'nelle_warning.g.dart';

@JsonSerializable()
class NelleWarning {
  const NelleWarning({
    required this.code,
    required this.message,
    this.detail,
  });
  
  factory NelleWarning.fromJson(Map<String, Object?> json) => _$NelleWarningFromJson(json);
  
  final String code;
  final String message;
  final String? detail;

  Map<String, Object?> toJson() => _$NelleWarningToJson(this);
}
