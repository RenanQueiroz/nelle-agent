import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nelle_agent/src/features/chat/code_highlight.dart';

const _base = TextStyle(fontFamily: 'monospace', fontSize: 13);

String _plain(TextSpan span) {
  final buffer = StringBuffer();
  span.computeToPlainText(buffer);
  return buffer.toString();
}

void main() {
  test('a known language is highlighted into spans', () {
    final span = CodeHighlighter.highlight(
      source: "void main() { print('hi'); }",
      language: 'dart',
      base: _base,
      brightness: Brightness.light,
    );

    expect(span, isNotNull);
    // Highlighting must not alter a single character of the code.
    expect(_plain(span!), "void main() { print('hi'); }");
    expect(span.children, isNotEmpty);
  });

  test('highlighting is never load-bearing', () {
    // A language nobody knows, no language at all, and a block that is still
    // streaming and syntactically half-written. Each falls back to plain text rather
    // than throwing into the middle of a transcript.
    expect(
      CodeHighlighter.highlight(
        source: 'x',
        language: 'not-a-language',
        base: _base,
        brightness: Brightness.light,
      ),
      isNull,
    );
    expect(
      CodeHighlighter.highlight(
        source: 'x',
        language: null,
        base: _base,
        brightness: Brightness.light,
      ),
      isNull,
    );
    final half = CodeHighlighter.highlight(
      source: 'void main() { print("unterminated',
      language: 'dart',
      base: _base,
      brightness: Brightness.light,
    );
    expect(_plain(half!), 'void main() { print("unterminated');
  });

  test('the palette follows the app brightness', () {
    // The app carries a full dark theme and follows the platform. A syntax palette is
    // only legible against the background it was designed for, so a light palette on a
    // dark code block is dark-on-dark -- which is exactly what shipped until this test.
    Color? keywordOf(Brightness brightness) {
      final span = CodeHighlighter.highlight(
        source: 'void main() {}',
        language: 'dart',
        base: _base,
        brightness: brightness,
      );
      return _spans(span!)
          .firstWhere((s) => s.text == 'void', orElse: () => const TextSpan())
          .style
          ?.color;
    }

    final light = keywordOf(Brightness.light);
    final dark = keywordOf(Brightness.dark);
    expect(light, isNotNull);
    expect(dark, isNotNull);
    expect(dark, isNot(equals(light)));
  });
}

/// Every leaf span, flattened.
Iterable<TextSpan> _spans(TextSpan span) sync* {
  yield span;
  for (final child in span.children ?? const <InlineSpan>[]) {
    if (child is TextSpan) {
      yield* _spans(child);
    }
  }
}
