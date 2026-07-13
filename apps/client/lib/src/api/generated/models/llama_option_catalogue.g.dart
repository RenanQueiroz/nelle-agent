// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'llama_option_catalogue.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

LlamaOptionCatalogue _$LlamaOptionCatalogueFromJson(
  Map<String, dynamic> json,
) => LlamaOptionCatalogue(
  available: json['available'] as bool,
  options: (json['options'] as List<dynamic>)
      .map((e) => LlamaOption.fromJson(e as Map<String, dynamic>))
      .toList(),
);

Map<String, dynamic> _$LlamaOptionCatalogueToJson(
  LlamaOptionCatalogue instance,
) => <String, dynamic>{
  'available': instance.available,
  'options': instance.options,
};
