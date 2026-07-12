// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'refresh_request.g.dart';

@JsonSerializable()
class RefreshRequest {
  const RefreshRequest({required this.refreshToken});

  factory RefreshRequest.fromJson(Map<String, Object?> json) =>
      _$RefreshRequestFromJson(json);

  final String refreshToken;

  Map<String, Object?> toJson() => _$RefreshRequestToJson(this);
}
