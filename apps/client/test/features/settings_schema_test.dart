import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/settings_schema.dart';

Map<String, Object?> _field(
  String type, [
  Map<String, Object?> extra = const {},
]) => {'key': 'k', 'label': 'L', 'help': 'H', 'type': type, ...extra};

void main() {
  group('SettingsField switches on the wire type', () {
    test('textarea is NOT text -- the bug that made this hand-written', () {
      // swagger_parser deserializes the served `oneOf` by *trying each variant until one
      // does not throw*. `text` and `textarea` carry identical keys apart from the
      // `type` literal, so a textarea came back as a text field: a single-line box where
      // custom instructions -- 8,000 characters of them -- are supposed to go. Silently,
      // and forever.
      final text = SettingsField.fromJson(_field('text', {'default': 'a'}));
      final textarea = SettingsField.fromJson(
        _field('textarea', {'default': 'a'}),
      );

      expect(text, isA<TextSettingsField>());
      expect(textarea, isA<TextSettingsField>());
      expect((text as TextSettingsField).multiline, isFalse);
      expect((textarea as TextSettingsField).multiline, isTrue);
    });

    test('a number field carries its bounds', () {
      final field = SettingsField.fromJson(
        _field('number', {
          'default': 2500,
          'min': 0,
          'max': 40000,
          'step': 100,
          'integer': true,
        }),
      );

      expect(field, isA<NumberSettingsField>());
      final number = field as NumberSettingsField;
      expect(number.defaultValue, 2500);
      expect(number.min, 0);
      expect(number.max, 40000);
      expect(number.step, 100);
      // Rejects 2.5 where only whole numbers make sense, e.g. a word count.
      expect(number.integer, isTrue);
    });

    test('a boolean field', () {
      final field = SettingsField.fromJson(
        _field('boolean', {'default': true}),
      );
      expect(field, isA<BooleanSettingsField>());
      expect((field as BooleanSettingsField).defaultValue, isTrue);
    });

    test('a select field carries its options in order', () {
      final field = SettingsField.fromJson(
        _field('select', {
          'default': 'llm',
          'options': [
            {'value': 'llm', 'label': 'Ask the model'},
            {'value': 'first-line', 'label': 'First line'},
          ],
        }),
      );

      expect(field, isA<SelectSettingsField>());
      final select = field as SelectSettingsField;
      expect(select.defaultValue, 'llm');
      expect(select.options.map((o) => o.value), ['llm', 'first-line']);
      expect(select.options.first.label, 'Ask the model');
    });

    test('a text field carries maxLength and the token-cost hint', () {
      final field =
          SettingsField.fromJson(
                _field('textarea', {
                  'default': '',
                  'maxLength': 8000,
                  'tokenCost': true,
                }),
              )
              as TextSettingsField;

      // A rendering hint the *server* serves, so the client shows a token cost without
      // knowing what the field means.
      expect(field.maxLength, 8000);
      expect(field.tokenCost, isTrue);
    });

    test('a field type this build has never heard of does not throw', () {
      // The whole point of serving a schema: a newer server may grow a field type, and
      // an older client must skip it and render the rest. Crashing here would make every
      // server release a breaking change for every phone that had not updated.
      final field = SettingsField.fromJson(
        _field('colour-picker', {'default': '#fff'}),
      );

      expect(field, isA<UnknownSettingsField>());
      expect((field as UnknownSettingsField).type, 'colour-picker');
      // It still knows what it is called, so a client *could* say "not supported here".
      expect(field.key, 'k');
      expect(field.label, 'L');
    });

    test('a field with no type at all is unknown, not an exception', () {
      final field = SettingsField.fromJson({
        'key': 'k',
        'label': 'L',
        'help': 'H',
      });
      expect(field, isA<UnknownSettingsField>());
    });
  });

  group('sections', () {
    test(
      'a section parses its fields and keeps its slug -- the route segment',
      () {
        final section = SettingsSection.fromJson({
          'slug': 'attachments',
          'title': 'Attachments',
          'description': 'What happens to the things you paste.',
          'fields': [
            _field('number', {'default': 2500}),
            _field('boolean', {'default': false}),
          ],
        });

        // The slug is both the settings-table row key and `GET`/`PATCH /api/settings/<slug>`.
        expect(section.slug, 'attachments');
        expect(section.title, 'Attachments');
        expect(section.description, 'What happens to the things you paste.');
        expect(section.fields, hasLength(2));
        expect(section.fields.first, isA<NumberSettingsField>());
      },
    );

    test(
      'a section with an unknown field still parses the fields around it',
      () {
        final section = SettingsSection.fromJson({
          'slug': 's',
          'title': 'T',
          'fields': [
            _field('boolean', {'default': true}),
            _field('colour-picker'),
            _field('number', {'default': 1}),
          ],
        });

        // One field from the future must not cost the user the other two.
        expect(section.fields, hasLength(3));
        expect(section.fields[0], isA<BooleanSettingsField>());
        expect(section.fields[1], isA<UnknownSettingsField>());
        expect(section.fields[2], isA<NumberSettingsField>());
      },
    );

    test('an empty or malformed schema parses to no sections, not a crash', () {
      expect(SettingsSchema.fromJson({}).sections, isEmpty);
      expect(SettingsSchema.fromJson({'sections': null}).sections, isEmpty);
    });
  });
}
