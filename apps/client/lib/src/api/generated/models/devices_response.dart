// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'device_view.dart';

part 'devices_response.g.dart';

@JsonSerializable()
class DevicesResponse {
  const DevicesResponse({required this.devices});

  factory DevicesResponse.fromJson(Map<String, Object?> json) =>
      _$DevicesResponseFromJson(json);

  final List<DeviceView> devices;

  Map<String, Object?> toJson() => _$DevicesResponseToJson(this);
}
