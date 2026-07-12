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
      ),
      isNull,
    );
    expect(
      CodeHighlighter.highlight(source: 'x', language: null, base: _base),
      isNull,
    );
    final half = CodeHighlighter.highlight(
      source: 'void main() { print("unterminated',
      language: 'dart',
      base: _base,
    );
    expect(_plain(half!), 'void main() { print("unterminated');
  });
}
