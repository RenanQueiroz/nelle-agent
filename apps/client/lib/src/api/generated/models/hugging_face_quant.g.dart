// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'hugging_face_quant.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

HuggingFaceQuant _$HuggingFaceQuantFromJson(Map<String, dynamic> json) =>
    HuggingFaceQuant(
      quant: json['quant'] as String,
      size: json['size'] as num?,
      files: (json['files'] as List<dynamic>)
          .map((e) => HuggingFaceFile.fromJson(e as Map<String, dynamic>))
          .toList(),
    );

Map<String, dynamic> _$HuggingFaceQuantToJson(HuggingFaceQuant instance) =>
    <String, dynamic>{
      'quant': instance.quant,
      'size': instance.size,
      'files': instance.files,
    };
