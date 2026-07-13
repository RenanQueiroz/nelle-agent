// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'hugging_face_file.g.dart';

@JsonSerializable()
class HuggingFaceFile {
  const HuggingFaceFile({required this.filename, required this.size});

  factory HuggingFaceFile.fromJson(Map<String, Object?> json) =>
      _$HuggingFaceFileFromJson(json);

  final String filename;
  final num? size;

  Map<String, Object?> toJson() => _$HuggingFaceFileToJson(this);
}
