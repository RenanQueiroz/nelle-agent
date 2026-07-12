// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'kind.dart';
import 'active_run_status.dart';

part 'current_run.g.dart';

@JsonSerializable()
class CurrentRun {
  const CurrentRun({
    required this.runId,
    required this.kind,
    required this.startedAt,
    required this.status,
    this.modelId,
  });

  factory CurrentRun.fromJson(Map<String, Object?> json) =>
      _$CurrentRunFromJson(json);

  final String runId;
  final Kind kind;
  final String? modelId;
  final String startedAt;
  final ActiveRunStatus status;

  Map<String, Object?> toJson() => _$CurrentRunToJson(this);
}
