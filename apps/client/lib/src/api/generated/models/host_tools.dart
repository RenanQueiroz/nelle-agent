// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'host_tools.g.dart';

@JsonSerializable()
class HostTools {
  const HostTools({
    required this.enabled,
    required this.acknowledged,
    required this.updatedAt,
  });

  factory HostTools.fromJson(Map<String, Object?> json) =>
      _$HostToolsFromJson(json);

  final bool enabled;
  final bool acknowledged;
  final String updatedAt;

  Map<String, Object?> toJson() => _$HostToolsToJson(this);
}
