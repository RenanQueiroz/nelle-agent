// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'capabilities.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Capabilities _$CapabilitiesFromJson(Map<String, dynamic> json) => Capabilities(
  canSend: json['canSend'] as bool,
  canAbort: json['canAbort'] as bool,
  canCompact: json['canCompact'] as bool,
  canFork: json['canFork'] as bool,
  canRepair: json['canRepair'] as bool,
  canAttachImages: json['canAttachImages'] as bool?,
  canReason: json['canReason'] as bool?,
);

Map<String, dynamic> _$CapabilitiesToJson(Capabilities instance) =>
    <String, dynamic>{
      'canSend': instance.canSend,
      'canAbort': instance.canAbort,
      'canCompact': instance.canCompact,
      'canFork': instance.canFork,
      'canRepair': instance.canRepair,
      'canAttachImages': instance.canAttachImages,
      'canReason': instance.canReason,
    };
