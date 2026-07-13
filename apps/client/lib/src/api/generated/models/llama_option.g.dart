// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'llama_option.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LlamaOption _$LlamaOptionFromJson(Map<String, dynamic> json) => LlamaOption(
  keys: (json['keys'] as List<dynamic>).map((e) => e as String).toList(),
  env: (json['env'] as List<dynamic>).map((e) => e as String).toList(),
  help: json['help'] as String,
  section: json['section'] as String,
  valueHint: json['valueHint'] as String?,
);

Map<String, dynamic> _$LlamaOptionToJson(LlamaOption instance) =>
    <String, dynamic>{
      'keys': instance.keys,
      'env': instance.env,
      'valueHint': instance.valueHint,
      'help': instance.help,
      'section': instance.section,
    };
