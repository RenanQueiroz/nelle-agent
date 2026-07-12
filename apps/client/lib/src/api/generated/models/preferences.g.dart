// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'preferences.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Preferences _$PreferencesFromJson(Map<String, dynamic> json) => Preferences(
  favoriteModelIds: (json['favoriteModelIds'] as List<dynamic>?)
      ?.map((e) => e as String)
      .toList(),
  showGenerationStats: json['showGenerationStats'] as bool?,
  showThinkingInProgress: json['showThinkingInProgress'] as bool?,
  showToolCallsInProgress: json['showToolCallsInProgress'] as bool?,
  renderUserContentAsMarkdown: json['renderUserContentAsMarkdown'] as bool?,
  renderThinkingAsMarkdown: json['renderThinkingAsMarkdown'] as bool?,
  disableAutoScroll: json['disableAutoScroll'] as bool?,
);

Map<String, dynamic> _$PreferencesToJson(Preferences instance) =>
    <String, dynamic>{
      'favoriteModelIds': instance.favoriteModelIds,
      'showGenerationStats': instance.showGenerationStats,
      'showThinkingInProgress': instance.showThinkingInProgress,
      'showToolCallsInProgress': instance.showToolCallsInProgress,
      'renderUserContentAsMarkdown': instance.renderUserContentAsMarkdown,
      'renderThinkingAsMarkdown': instance.renderThinkingAsMarkdown,
      'disableAutoScroll': instance.disableAutoScroll,
    };
