// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'llama_option.dart';

part 'llama_option_catalogue.g.dart';

@JsonSerializable()
class LlamaOptionCatalogue {
  const LlamaOptionCatalogue({required this.available, required this.options});

  factory LlamaOptionCatalogue.fromJson(Map<String, Object?> json) =>
      _$LlamaOptionCatalogueFromJson(json);

  final bool available;
  final List<LlamaOption> options;

  Map<String, Object?> toJson() => _$LlamaOptionCatalogueToJson(this);
}
