import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:forui/forui.dart';
import 'package:markdown/markdown.dart' as md;

import 'code_highlight.dart';

/// Renders a fenced code block: language label, copy button, and its own horizontal
/// scroll.
///
/// The package would otherwise render `pre` as bare scrolling text. Code is the payload
/// of a coding agent, so it gets chrome — and it **must** scroll inside itself: a long
/// line has to move the block, never the page.
class CodeBlockBuilder extends MarkdownElementBuilder {
  CodeBlockBuilder({required this.textStyle});

  final TextStyle textStyle;

  @override
  Widget? visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    // A fenced block is `pre > code`, and the language rides on the code element as
    // `class="language-dart"` — the HTML-shaped AST showing through.
    final code = element.children?.whereType<md.Element>().firstWhere(
      (child) => child.tag == 'code',
      orElse: () => element,
    );
    final source = (code ?? element).textContent.trimRight();
    return _CodeBlock(
      source: source,
      language: _language(code),
      textStyle: textStyle,
    );
  }

  String? _language(md.Element? code) {
    final classes = code?.attributes['class'];
    if (classes == null) {
      return null;
    }
    for (final name in classes.split(' ')) {
      if (name.startsWith('language-') && name.length > 'language-'.length) {
        return name.substring('language-'.length);
      }
    }
    return null;
  }
}

class _CodeBlock extends StatelessWidget {
  const _CodeBlock({
    required this.source,
    required this.language,
    required this.textStyle,
  });

  final String source;
  final String? language;
  final TextStyle textStyle;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      clipBehavior: Clip.hardEdge,
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _Header(
            source: source,
            language: language,
            // Keyed by content so several blocks in one answer stay distinguishable,
            // and the key survives a rebuild.
            copyKey: ValueKey('k-code-copy-${source.hashCode}'),
          ),
          // The block scrolls, not the page.
          Scrollbar(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
              child: _Source(
                source: source,
                language: language,
                textStyle: textStyle,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The code itself, highlighted when we can and plain monospace when we cannot.
///
/// Highlighting must never be load-bearing: an unknown language, or a block still
/// streaming and syntactically half-finished, simply falls back to the plain span.
class _Source extends StatelessWidget {
  const _Source({
    required this.source,
    required this.language,
    required this.textStyle,
  });

  final String source;
  final String? language;
  final TextStyle textStyle;

  @override
  Widget build(BuildContext context) {
    final highlighted = CodeHighlighter.highlight(
      source: source,
      language: language,
      base: textStyle,
    );
    return highlighted == null
        ? SelectableText(source, style: textStyle)
        : SelectableText.rich(highlighted, style: textStyle);
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.source,
    required this.language,
    required this.copyKey,
  });

  final String source;
  final String? language;
  final Key copyKey;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 4, 4, 4),
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: scheme.outlineVariant)),
      ),
      child: Row(
        children: [
          Text(
            language ?? 'code',
            style: TextStyle(fontSize: 11, color: scheme.outline),
          ),
          const Spacer(),
          GestureDetector(
            key: copyKey,
            behavior: HitTestBehavior.opaque,
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: source));
              if (context.mounted) {
                showFToast(
                  context: context,
                  icon: const Icon(FLucideIcons.check),
                  title: const Text('Copied'),
                );
              }
            },
            child: Padding(
              padding: const EdgeInsets.all(6),
              child: Icon(FLucideIcons.copy, size: 13, color: scheme.outline),
            ),
          ),
        ],
      ),
    );
  }
}
