// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'capabilities.g.dart';

@JsonSerializable()
class Capabilities {
  const Capabilities({
    required this.canSend,
    required this.canAbort,
    required this.canCompact,
    required this.canFork,
    required this.canRepair,
    required this.canAttachImages,
    required this.canReason,
  });
  
  factory Capabilities.fromJson(Map<String, Object?> json) => _$CapabilitiesFromJson(json);
  
  final bool canSend;
  final bool canAbort;
  final bool canCompact;
  final bool canFork;
  final bool canRepair;
  final bool? canAttachImages;
  final bool? canReason;

  Map<String, Object?> toJson() => _$CapabilitiesToJson(this);
}
