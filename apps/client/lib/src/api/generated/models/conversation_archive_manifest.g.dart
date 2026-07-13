// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'conversation_archive_manifest.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

ConversationArchiveManifest _$ConversationArchiveManifestFromJson(
  Map<String, dynamic> json,
) => ConversationArchiveManifest(
  format: json['format'] as String,
  version: json['version'] as num,
  exportedAt: json['exportedAt'] as String,
  appVersion: json['appVersion'] as String,
  files: Map<String, String>.from(json['files'] as Map),
  conversation: json['conversation'] == null
      ? null
      : ArchiveConversationRef.fromJson(
          json['conversation'] as Map<String, dynamic>,
        ),
  source: json['source'] == null
      ? null
      : ArchiveSource.fromJson(json['source'] as Map<String, dynamic>),
  piSessionMissing: json['piSessionMissing'] as bool?,
);

Map<String, dynamic> _$ConversationArchiveManifestToJson(
  ConversationArchiveManifest instance,
) => <String, dynamic>{
  'format': instance.format,
  'version': instance.version,
  'exportedAt': instance.exportedAt,
  'appVersion': instance.appVersion,
  'conversation': instance.conversation,
  'source': instance.source,
  'piSessionMissing': instance.piSessionMissing,
  'files': instance.files,
};
