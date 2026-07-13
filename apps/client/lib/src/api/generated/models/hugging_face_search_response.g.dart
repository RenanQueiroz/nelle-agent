// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'hugging_face_search_response.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HuggingFaceSearchResponse _$HuggingFaceSearchResponseFromJson(
  Map<String, dynamic> json,
) => HuggingFaceSearchResponse(
  results: (json['results'] as List<dynamic>)
      .map((e) => HuggingFaceModelResult.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$HuggingFaceSearchResponseToJson(
  HuggingFaceSearchResponse instance,
) => <String, dynamic>{'results': instance.results};
