// coverage:ignore-file
// GENERATED CODE - DO NOT MODIFY BY HAND
// ignore_for_file: type=lint, unused_import, invalid_annotation_target, unnecessary_import

import 'package:json_annotation/json_annotation.dart';

part 'preferences.g.dart';

@JsonSerializable()
class Preferences {
  const Preferences({this.favoriteModelIds});

  factory Preferences.fromJson(Map<String, Object?> json) =>
      _$PreferencesFromJson(json);

  final List<String>? favoriteModelIds;

  Map<String, Object?> toJson() => _$PreferencesToJson(this);
}
