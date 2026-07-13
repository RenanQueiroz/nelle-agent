// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'runtime_status.dart';

part 'llama_router_props.g.dart';

@JsonSerializable()
class LlamaRouterProps {
  const LlamaRouterProps({
    required this.role,
    required this.maxInstances,
    required this.modelsAutoload,
    required this.runtime,
  });

  factory LlamaRouterProps.fromJson(Map<String, Object?> json) =>
      _$LlamaRouterPropsFromJson(json);

  final String? role;
  final num? maxInstances;
  final bool? modelsAutoload;
  final RuntimeStatus runtime;

  Map<String, Object?> toJson() => _$LlamaRouterPropsToJson(this);
}
