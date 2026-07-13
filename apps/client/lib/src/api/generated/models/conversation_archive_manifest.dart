// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

import 'archive_conversation_ref.dart';
import 'archive_source.dart';

part 'conversation_archive_manifest.g.dart';

@JsonSerializable()
class ConversationArchiveManifest {
  const ConversationArchiveManifest({
    required this.format,
    required this.version,
    required this.exportedAt,
    required this.appVersion,
    required this.files,
    this.conversation,
    this.source,
    this.piSessionMissing,
  });

  factory ConversationArchiveManifest.fromJson(Map<String, Object?> json) =>
      _$ConversationArchiveManifestFromJson(json);

  final String format;
  final num version;
  final String exportedAt;
  final String appVersion;
  final ArchiveConversationRef? conversation;
  final ArchiveSource? source;
  final bool? piSessionMissing;
  final Map<String, String> files;

  Map<String, Object?> toJson() => _$ConversationArchiveManifestToJson(this);
}
