// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'tool_call_event.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ToolCallEvent _$ToolCallEventFromJson(Map<String, dynamic> json) =>
    ToolCallEvent(
      id: json['id'] as String,
      name: json['name'] as String,
      status: ToolCallEventStatus.fromJson(json['status'] as String),
      target: json['target'] as String?,
      duration: json['duration'] as String?,
      input: json['input'] as String?,
      output: json['output'] as String?,
      errorMessage: json['errorMessage'] as String?,
    );

Map<String, dynamic> _$ToolCallEventToJson(ToolCallEvent instance) =>
    <String, dynamic>{
      'id': instance.id,
      'name': instance.name,
      'target': instance.target,
      'status': instance.status,
      'duration': instance.duration,
      'input': instance.input,
      'output': instance.output,
      'errorMessage': instance.errorMessage,
    };
