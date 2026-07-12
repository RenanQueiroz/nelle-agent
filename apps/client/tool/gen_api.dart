// Produces a models-only copy of the server's OpenAPI so swagger_parser emits
// DTOs without a REST client (we hand-write dio for SSE + auth control) and
// without the per-path error-wrapper noise.
//
// Regenerate the API models with:
//   dart run tool/gen_api.dart
//   dart run swagger_parser
//   dart run build_runner build --delete-conflicting-outputs
//   dart format lib/src/api/generated
//
// The format step is not cosmetic: swagger_parser emits unformatted Dart, and any
// later `dart format` over the package (an IDE, a hook) rewrites it — so without it
// the committed generated code and the generator's own output never agree, and the
// diff flips back and forth.
import 'dart:convert';
import 'dart:io';

void main() {
  final specFile = File('../../openapi.json');
  if (!specFile.existsSync()) {
    stderr.writeln(
      'openapi.json not found at ${specFile.absolute.path} — run `bun run build:openapi` first.',
    );
    exit(1);
  }
  final spec = jsonDecode(specFile.readAsStringSync()) as Map<String, dynamic>;
  // Drop paths: with no operations, swagger_parser generates only the component
  // schemas (our DTOs), no clients, and none of the inline `{error: ...}` wrappers.
  spec['paths'] = <String, dynamic>{};
  // Drop the ChatStreamEvent oneOf: swagger_parser expands 18 variants into a
  // `variant1..16` mess. It is hand-written (lib/src/api/chat_stream_event.dart)
  // from the clean building-block DTOs (ChatMessage, ChatPerformance, ...), which
  // stay as their own components.
  //
  // The settings schema goes the same way, for a sharper reason. swagger_parser
  // turns `SettingsField` into `SettingsFieldSealedVariant1..5` and deserializes by
  // *trying each variant until one does not throw* -- and `text` and `textarea`
  // carry identical keys apart from the `type` literal, so a textarea would come
  // back as a text field, silently, forever. It is hand-written in
  // lib/src/api/settings_schema.dart, switching on the wire `type`, which is the
  // stable contract. `SettingsSection` and `SettingsSchema` go with it because they
  // reference it.
  final schemas = ((spec['components'] as Map)['schemas']) as Map;
  for (final id in [
    'ChatStreamEvent',
    'SettingsField',
    'SettingsSection',
    'SettingsSchema',
  ]) {
    schemas.remove(id);
  }
  final out = File('openapi.models.json');
  out.writeAsStringSync(
    '${const JsonEncoder.withIndent('  ').convert(spec)}\n',
  );
  stdout.writeln(
    'wrote ${out.path} (models-only, ${(spec['components'] as Map)['schemas'].length} schemas)',
  );
}
