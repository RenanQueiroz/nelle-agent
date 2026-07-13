// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'llama_router_props.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LlamaRouterProps _$LlamaRouterPropsFromJson(Map<String, dynamic> json) =>
    LlamaRouterProps(
      role: json['role'] as String?,
      maxInstances: json['maxInstances'] as num?,
      modelsAutoload: json['modelsAutoload'] as bool?,
      runtime: RuntimeStatus.fromJson(json['runtime'] as Map<String, dynamic>),
    );

Map<String, dynamic> _$LlamaRouterPropsToJson(LlamaRouterProps instance) =>
    <String, dynamic>{
      'role': instance.role,
      'maxInstances': instance.maxInstances,
      'modelsAutoload': instance.modelsAutoload,
      'runtime': instance.runtime,
    };
