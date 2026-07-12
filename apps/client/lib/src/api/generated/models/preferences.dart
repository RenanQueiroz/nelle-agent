// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'preferences.g.dart';

@JsonSerializable()
class Preferences {
  const Preferences({
    this.favoriteModelIds,
    this.showGenerationStats,
    this.showThinkingInProgress,
    this.showToolCallsInProgress,
    this.renderUserContentAsMarkdown,
    this.renderThinkingAsMarkdown,
    this.disableAutoScroll,
  });

  factory Preferences.fromJson(Map<String, Object?> json) =>
      _$PreferencesFromJson(json);

  final List<String>? favoriteModelIds;
  final bool? showGenerationStats;
  final bool? showThinkingInProgress;
  final bool? showToolCallsInProgress;
  final bool? renderUserContentAsMarkdown;
  final bool? renderThinkingAsMarkdown;
  final bool? disableAutoScroll;

  Map<String, Object?> toJson() => _$PreferencesToJson(this);
}
