import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/api/router_event.dart';

void main() {
  group(
    'RouterModelEvent.fromJson (llama.cpp\'s own shape, not a Nelle envelope)',
    () {
      test('reads the top-level model id and the nested progress value', () {
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL',
          'data': {
            'status': 'loading',
            'progress': {'value': 0.67},
          },
        });

        // The id is top-level, NOT inside `data` — the trap this type exists to avoid.
        expect(event!.modelId, 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL');
        expect(event.status, 'loading');
        expect(event.progress, 0.67);
      });

      test('staged progress is a fraction of the WHOLE load, not of a stage', () {
        // Captured verbatim off llama.cpp's wire: a vision model loads in two stages
        // and `value` restarts at 0 for each. Reading `value` alone fills the bar,
        // snaps it back to zero, and fills it again.
        RouterModelEvent? at(String stage, double value) =>
            RouterModelEvent.fromJson(<String, dynamic>{
              'model': 'm',
              'event': 'status_change',
              'data': {
                'status': 'loading',
                'progress': {
                  'stages': ['text_model', 'mmproj_model'],
                  'current': stage,
                  'value': value,
                },
              },
            });

        expect(at('text_model', 0.0)!.progress, 0.0);
        expect(at('text_model', 0.5)!.progress, 0.25);
        expect(at('text_model', 1.0)!.progress, 0.5);
        // The second stage restarts at value 0 — and must NOT rewind the bar.
        expect(at('mmproj_model', 0.0)!.progress, 0.5);
        expect(at('mmproj_model', 1.0)!.progress, 1.0);
      });

      test('a bare stage announcement carries no measurement', () {
        // llama.cpp emits `{"stage": "mmproj_model"}` (singular, no value) between
        // stages. It says nothing about progress, so it must not reset it to 0.
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'm',
          'data': {
            'status': 'loading',
            'progress': {'stage': 'mmproj_model'},
          },
        });

        expect(event!.status, 'loading');
        expect(event.progress, isNull);
      });

      test('an unknown stage name falls back to the raw value', () {
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'm',
          'data': {
            'status': 'loading',
            'progress': {
              'stages': ['text_model'],
              'current': 'a_stage_we_do_not_know',
              'value': 0.4,
            },
          },
        });

        expect(event!.progress, 0.4);
      });

      test('tolerates a bare numeric progress', () {
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'm',
          'data': {'status': 'loading', 'progress': 0.5},
        });

        expect(event!.progress, 0.5);
      });

      test('a status-only event carries no progress', () {
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'm',
          'data': {'status': 'loaded'},
        });

        expect(event!.status, 'loaded');
        expect(event.progress, isNull);
      });

      test('any llama.cpp status is accepted — it is not an enum', () {
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'model': 'm',
          'data': {'status': 'a-status-a-future-llamacpp-invents'},
        });

        expect(event!.status, 'a-status-a-future-llamacpp-invents');
      });

      test('a frame that names no model is dropped, not guessed at', () {
        expect(
          RouterModelEvent.fromJson(<String, dynamic>{'data': {}}),
          isNull,
        );
        expect(
          RouterModelEvent.fromJson(<String, dynamic>{'model': ''}),
          isNull,
        );
      });

      test('a Nelle chat envelope is not mistaken for a router event', () {
        // Chat envelopes have {type, data} and no top-level `model`. Silently
        // half-parsing one here is exactly the bug the separate type prevents.
        final event = RouterModelEvent.fromJson(<String, dynamic>{
          'type': 'message.assistant.delta',
          'data': {'type': 'message.assistant.delta', 'id': 'm', 'delta': 'hi'},
        });

        expect(event, isNull);
      });
    },
  );
}
