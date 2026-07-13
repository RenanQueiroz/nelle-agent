// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'conversation2.g.dart';

@JsonSerializable()
class Conversation2 {
  const Conversation2({required this.id, required this.title});

  factory Conversation2.fromJson(Map<String, Object?> json) =>
      _$Conversation2FromJson(json);

  final String id;
  final String title;

  Map<String, Object?> toJson() => _$Conversation2ToJson(this);
}
