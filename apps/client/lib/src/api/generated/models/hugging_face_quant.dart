// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'hugging_face_file.dart';

part 'hugging_face_quant.g.dart';

@JsonSerializable()
class HuggingFaceQuant {
  const HuggingFaceQuant({
    required this.quant,
    required this.size,
    required this.files,
  });

  factory HuggingFaceQuant.fromJson(Map<String, Object?> json) =>
      _$HuggingFaceQuantFromJson(json);

  final String quant;
  final num? size;
  final List<HuggingFaceFile> files;

  Map<String, Object?> toJson() => _$HuggingFaceQuantToJson(this);
}
