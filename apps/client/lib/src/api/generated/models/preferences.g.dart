// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'preferences.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

Preferences _$PreferencesFromJson(Map<String, dynamic> json) => Preferences(
  favoriteModelIds: (json['favoriteModelIds'] as List<dynamic>?)
      ?.map((e) => e as String)
      .toList(),
);

Map<String, dynamic> _$PreferencesToJson(Preferences instance) =>
    <String, dynamic>{'favoriteModelIds': instance.favoriteModelIds};
