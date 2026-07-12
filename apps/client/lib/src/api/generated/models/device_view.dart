// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'device_view.g.dart';

@JsonSerializable()
class DeviceView {
  const DeviceView({
    required this.id,
    required this.name,
    required this.platform,
    required this.createdAt,
    required this.lastSeenAt,
  });

  factory DeviceView.fromJson(Map<String, Object?> json) =>
      _$DeviceViewFromJson(json);

  final String id;
  final String name;
  final String? platform;
  final String createdAt;
  final String? lastSeenAt;

  Map<String, Object?> toJson() => _$DeviceViewToJson(this);
}
