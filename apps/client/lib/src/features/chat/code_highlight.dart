import 'package:flutter/material.dart';
import 'package:re_highlight/languages/all.dart';
import 'package:re_highlight/re_highlight.dart';
import 'package:re_highlight/styles/atom-one-dark.dart';
import 'package:re_highlight/styles/atom-one-light.dart';

/// Syntax highlighting for fenced code blocks.
///
/// `re_highlight` is a Dart port of highlight.js. The obvious package,
/// `flutter_highlight`, is a dead end: it depends on `highlight.dart`, which is
/// **discontinued** — this one exists to replace it.
///
/// Highlighting is a nicety, not a requirement: anything that fails here falls back to
/// the plain monospace span, so an unknown language or a half-streamed block is never an
/// error. It stays behind this one function for the same reason the renderer does —
/// the package is small (0.0.3) and must be droppable.
class CodeHighlighter {
  CodeHighlighter._();

  static final _highlight = Highlight()..registerLanguages(builtinAllLanguages);

  /// Highlights [source] as [language], or returns null when it cannot — an unknown
  /// language, or highlight.js choking on a fragment that is still streaming.
  ///
  /// [brightness] is the *app's*, not the block's: the app carries a full dark theme and
  /// follows the platform, and a syntax palette is only legible against the background it
  /// was designed for. A light palette on a dark code block is dark-on-dark.
  static TextSpan? highlight({
    required String source,
    required String? language,
    required TextStyle base,
    required Brightness brightness,
  }) {
    final name = language?.toLowerCase();
    if (name == null || !_highlight.listLanguages().contains(name)) {
      return null;
    }
    try {
      final result = _highlight.highlight(code: source, language: name);
      final renderer = TextSpanRenderer(base, _theme(base, brightness));
      result.render(renderer);
      return renderer.span;
    } catch (_) {
      return null;
    }
  }

  /// The package's palette for this brightness, with its own background dropped — the
  /// block already paints one, and a second shows as a misaligned rectangle behind the
  /// text.
  static Map<String, TextStyle> _theme(TextStyle base, Brightness brightness) {
    final palette = brightness == Brightness.dark
        ? atomOneDarkTheme
        : atomOneLightTheme;
    return {
      for (final entry in palette.entries)
        if (entry.key != 'root')
          entry.key: entry.value.copyWith(
            fontFamily: base.fontFamily,
            fontFamilyFallback: base.fontFamilyFallback,
            fontSize: base.fontSize,
            height: base.height,
            backgroundColor: Colors.transparent,
          ),
    };
  }
}
