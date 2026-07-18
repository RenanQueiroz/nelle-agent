// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'runtime_install_request.g.dart';

@JsonSerializable()
class RuntimeInstallRequest {
  const RuntimeInstallRequest({this.version});

  factory RuntimeInstallRequest.fromJson(Map<String, Object?> json) =>
      _$RuntimeInstallRequestFromJson(json);

  final String? version;

  Map<String, Object?> toJson() => _$RuntimeInstallRequestToJson(this);
}
