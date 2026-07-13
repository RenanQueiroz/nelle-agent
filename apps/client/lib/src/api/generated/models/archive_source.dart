// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'archive_source.g.dart';

@JsonSerializable()
class ArchiveSource {
  const ArchiveSource({required this.platform});

  factory ArchiveSource.fromJson(Map<String, Object?> json) =>
      _$ArchiveSourceFromJson(json);

  final String platform;

  Map<String, Object?> toJson() => _$ArchiveSourceToJson(this);
}
