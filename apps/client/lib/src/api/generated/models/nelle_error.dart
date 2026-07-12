// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'nelle_error.g.dart';

@JsonSerializable()
class NelleError {
  const NelleError({
    required this.code,
    required this.message,
    this.detail,
    this.retryable,
    this.logRef,
  });
  
  factory NelleError.fromJson(Map<String, Object?> json) => _$NelleErrorFromJson(json);
  
  final String code;
  final String message;
  final String? detail;
  final bool? retryable;
  final String? logRef;

  Map<String, Object?> toJson() => _$NelleErrorToJson(this);
}
