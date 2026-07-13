// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'hugging_face_model_result.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HuggingFaceModelResult _$HuggingFaceModelResultFromJson(
  Map<String, dynamic> json,
) => HuggingFaceModelResult(
  id: json['id'] as String,
  tags: (json['tags'] as List<dynamic>).map((e) => e as String).toList(),
  files: (json['files'] as List<dynamic>)
      .map((e) => HuggingFaceFile.fromJson(e as Map<String, dynamic>))
      .toList(),
  quants: (json['quants'] as List<dynamic>)
      .map((e) => HuggingFaceQuant.fromJson(e as Map<String, dynamic>))
      .toList(),
  author: json['author'] as String?,
  downloads: json['downloads'] as num?,
  likes: json['likes'] as num?,
  architecture: json['architecture'] as String?,
  parameterCount: json['parameterCount'] as num?,
  contextTrain: json['contextTrain'] as num?,
);

Map<String, dynamic> _$HuggingFaceModelResultToJson(
  HuggingFaceModelResult instance,
) => <String, dynamic>{
  'id': instance.id,
  'author': instance.author,
  'downloads': instance.downloads,
  'likes': instance.likes,
  'tags': instance.tags,
  'architecture': instance.architecture,
  'parameterCount': instance.parameterCount,
  'contextTrain': instance.contextTrain,
  'files': instance.files,
  'quants': instance.quants,
};
