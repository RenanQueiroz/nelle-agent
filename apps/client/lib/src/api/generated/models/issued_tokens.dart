// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'issued_tokens.g.dart';

@JsonSerializable()
class IssuedTokens {
  const IssuedTokens({
    required this.accessToken,
    required this.accessExpiresAt,
    required this.refreshToken,
  });

  factory IssuedTokens.fromJson(Map<String, Object?> json) =>
      _$IssuedTokensFromJson(json);

  final String accessToken;
  final String accessExpiresAt;
  final String refreshToken;

  Map<String, Object?> toJson() => _$IssuedTokensToJson(this);
}
