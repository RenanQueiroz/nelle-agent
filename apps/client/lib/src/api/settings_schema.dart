// `package:meta`, not `package:flutter/foundation` -- which re-exports `@immutable` but
// drags in `dart:ui` with it, making this file unusable from a plain `dart run` tool.
// Same rule as the token store: a pure contract stays Flutter-free.
import 'package:meta/meta.dart';

/// The settings schema, hand-written — like [ChatStreamEvent], and for the same reason.
///
/// `swagger_parser` turns the served `SettingsField` `oneOf` into
/// `SettingsFieldSealedVariant1..5` and deserializes by **trying each variant until one
/// does not throw**. `text` and `textarea` carry identical keys apart from the `type`
/// literal, so a textarea would come back as a text field — silently, forever, with a
/// single-line control where a paragraph belongs.
///
/// So it switches on the wire `type`, which is the stable contract, and an unrecognised
/// type becomes [UnknownSettingsField] rather than an exception. That is the whole point
/// of serving a schema: a server that grows a field type this build has never heard of
/// must not break the settings screen — the field is skipped, the section still renders.
@immutable
sealed class SettingsField {
  const SettingsField({
    required this.key,
    required this.label,
    required this.help,
  });

  /// A field key is a contract, like an error code: a client stores it, and there is no
  /// migration path through a phone's cache.
  final String key;
  final String label;

  /// One sentence, shown beneath the control. Says what the setting does.
  final String help;

  factory SettingsField.fromJson(Map<String, Object?> json) {
    final key = json['key'] as String? ?? '';
    final label = json['label'] as String? ?? '';
    final help = json['help'] as String? ?? '';

    return switch (json['type']) {
      'text' => TextSettingsField(
        key: key,
        label: label,
        help: help,
        defaultValue: json['default'] as String? ?? '',
        maxLength: (json['maxLength'] as num?)?.toInt(),
        tokenCost: json['tokenCost'] as bool? ?? false,
        multiline: false,
      ),
      'textarea' => TextSettingsField(
        key: key,
        label: label,
        help: help,
        defaultValue: json['default'] as String? ?? '',
        maxLength: (json['maxLength'] as num?)?.toInt(),
        tokenCost: json['tokenCost'] as bool? ?? false,
        multiline: true,
      ),
      'number' => NumberSettingsField(
        key: key,
        label: label,
        help: help,
        defaultValue: (json['default'] as num?)?.toDouble() ?? 0,
        min: (json['min'] as num?)?.toDouble(),
        max: (json['max'] as num?)?.toDouble(),
        step: (json['step'] as num?)?.toDouble(),
        integer: json['integer'] as bool? ?? false,
      ),
      'boolean' => BooleanSettingsField(
        key: key,
        label: label,
        help: help,
        defaultValue: json['default'] as bool? ?? false,
      ),
      'select' => SelectSettingsField(
        key: key,
        label: label,
        help: help,
        defaultValue: json['default'] as String? ?? '',
        options: [
          for (final option
              in (json['options'] as List?)?.cast<Map<String, Object?>>() ??
                  const <Map<String, Object?>>[])
            SettingsSelectOption(
              value: option['value'] as String? ?? '',
              label: option['label'] as String? ?? '',
            ),
        ],
      ),
      final unknown => UnknownSettingsField(
        key: key,
        label: label,
        help: help,
        type: unknown is String ? unknown : '',
      ),
    };
  }
}

/// `text` and `textarea` differ only in how tall the control is, so they are one class
/// with a [multiline] flag. Two classes would be two identical widgets.
@immutable
class TextSettingsField extends SettingsField {
  const TextSettingsField({
    required super.key,
    required super.label,
    required super.help,
    required this.defaultValue,
    required this.multiline,
    this.maxLength,
    this.tokenCost = false,
  });

  final String defaultValue;
  final bool multiline;
  final int? maxLength;

  /// Show an estimated token cost beneath the control. A rendering hint the *server*
  /// serves, so the client shows the cost without knowing what the field means.
  final bool tokenCost;
}

@immutable
class NumberSettingsField extends SettingsField {
  const NumberSettingsField({
    required super.key,
    required super.label,
    required super.help,
    required this.defaultValue,
    this.min,
    this.max,
    this.step,
    this.integer = false,
  });

  final double defaultValue;
  final double? min;
  final double? max;
  final double? step;

  /// Rejects `2.5` where only whole numbers make sense, e.g. a word count.
  final bool integer;
}

@immutable
class BooleanSettingsField extends SettingsField {
  const BooleanSettingsField({
    required super.key,
    required super.label,
    required super.help,
    required this.defaultValue,
  });

  final bool defaultValue;
}

@immutable
class SelectSettingsField extends SettingsField {
  const SelectSettingsField({
    required super.key,
    required super.label,
    required super.help,
    required this.defaultValue,
    required this.options,
  });

  final String defaultValue;
  final List<SettingsSelectOption> options;
}

/// A field type this build has never heard of.
///
/// Not an error: a newer server is allowed to grow one, and an older client is expected
/// to skip it and render the rest. Crashing here would make every future server release
/// a breaking change for every phone that had not updated.
@immutable
class UnknownSettingsField extends SettingsField {
  const UnknownSettingsField({
    required super.key,
    required super.label,
    required super.help,
    required this.type,
  });

  final String type;
}

@immutable
class SettingsSelectOption {
  const SettingsSelectOption({required this.value, required this.label});

  final String value;
  final String label;
}

@immutable
class SettingsSection {
  const SettingsSection({
    required this.slug,
    required this.title,
    required this.fields,
    this.description,
  });

  /// Both the `settings` table row key and the route segment:
  /// `GET`/`PATCH /api/settings/<slug>`.
  final String slug;
  final String title;

  /// Shown once above the section's fields.
  final String? description;
  final List<SettingsField> fields;

  factory SettingsSection.fromJson(Map<String, Object?> json) =>
      SettingsSection(
        slug: json['slug'] as String? ?? '',
        title: json['title'] as String? ?? '',
        description: json['description'] as String?,
        fields: [
          for (final field
              in (json['fields'] as List?)?.cast<Map<String, Object?>>() ??
                  const <Map<String, Object?>>[])
            SettingsField.fromJson(field),
        ],
      );
}

@immutable
class SettingsSchema {
  const SettingsSchema({required this.sections});

  final List<SettingsSection> sections;

  factory SettingsSchema.fromJson(Map<String, Object?> json) => SettingsSchema(
    sections: [
      for (final section
          in (json['sections'] as List?)?.cast<Map<String, Object?>>() ??
              const <Map<String, Object?>>[])
        SettingsSection.fromJson(section),
    ],
  );
}
