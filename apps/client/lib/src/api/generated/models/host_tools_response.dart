// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'host_tools.dart';

part 'host_tools_response.g.dart';

@JsonSerializable()
class HostToolsResponse {
  const HostToolsResponse({
    required this.hostTools,
    required this.warning,
    required this.description,
  });

  factory HostToolsResponse.fromJson(Map<String, Object?> json) =>
      _$HostToolsResponseFromJson(json);

  final HostTools hostTools;
  final String warning;
  final String description;

  Map<String, Object?> toJson() => _$HostToolsResponseToJson(this);
}
