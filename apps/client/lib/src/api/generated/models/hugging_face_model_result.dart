// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'hugging_face_file.dart';
import 'hugging_face_quant.dart';

part 'hugging_face_model_result.g.dart';

@JsonSerializable()
class HuggingFaceModelResult {
  const HuggingFaceModelResult({
    required this.id,
    required this.tags,
    required this.files,
    required this.quants,
    this.author,
    this.downloads,
    this.likes,
    this.architecture,
    this.parameterCount,
    this.contextTrain,
  });

  factory HuggingFaceModelResult.fromJson(Map<String, Object?> json) =>
      _$HuggingFaceModelResultFromJson(json);

  final String id;
  final String? author;
  final num? downloads;
  final num? likes;
  final List<String> tags;
  final String? architecture;
  final num? parameterCount;
  final num? contextTrain;
  final List<HuggingFaceFile> files;
  final List<HuggingFaceQuant> quants;

  Map<String, Object?> toJson() => _$HuggingFaceModelResultToJson(this);
}
