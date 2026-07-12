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
