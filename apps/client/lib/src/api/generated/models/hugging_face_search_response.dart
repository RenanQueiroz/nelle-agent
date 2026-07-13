// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'hugging_face_model_result.dart';

part 'hugging_face_search_response.g.dart';

@JsonSerializable()
class HuggingFaceSearchResponse {
  const HuggingFaceSearchResponse({required this.results});

  factory HuggingFaceSearchResponse.fromJson(Map<String, Object?> json) =>
      _$HuggingFaceSearchResponseFromJson(json);

  final List<HuggingFaceModelResult> results;

  Map<String, Object?> toJson() => _$HuggingFaceSearchResponseToJson(this);
}
