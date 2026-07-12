// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'pair_request.g.dart';

@JsonSerializable()
class PairRequest {
  const PairRequest({
    required this.code,
    required this.deviceName,
    this.platform,
  });

  factory PairRequest.fromJson(Map<String, Object?> json) =>
      _$PairRequestFromJson(json);

  final String code;
  final String deviceName;
  final String? platform;

  Map<String, Object?> toJson() => _$PairRequestToJson(this);
}
