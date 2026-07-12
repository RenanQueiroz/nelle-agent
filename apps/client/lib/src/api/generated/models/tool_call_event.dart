// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'tool_call_event_status.dart';

part 'tool_call_event.g.dart';

@JsonSerializable()
class ToolCallEvent {
  const ToolCallEvent({
    required this.id,
    required this.name,
    required this.status,
    this.target,
    this.duration,
    this.input,
    this.output,
    this.errorMessage,
  });

  factory ToolCallEvent.fromJson(Map<String, Object?> json) =>
      _$ToolCallEventFromJson(json);

  final String id;
  final String name;
  final String? target;
  final ToolCallEventStatus status;
  final String? duration;
  final String? input;
  final String? output;
  final String? errorMessage;

  Map<String, Object?> toJson() => _$ToolCallEventToJson(this);
}
