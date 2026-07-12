import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
// Only the addon's *block* syntax is used. Its inline syntax treats `( x )` and `[ x ]`
// as maths, and its element builder mislays inline equations — see `latex_syntax.dart`
// and `latex_math.dart`, which replace both.
import 'package:flutter_markdown_plus_latex/flutter_markdown_plus_latex.dart'
    show LatexBlockSyntax;
import 'package:markdown/markdown.dart' as md;

import 'code_block.dart';
import 'latex_math.dart';
import 'latex_syntax.dart';

/// The **one** place markdown is rendered.
///
/// Nothing else in the app imports `flutter_markdown_plus`. The engine is a bet — the
/// original `flutter_markdown` was discontinued by Google and every option is a
/// successor — so keeping it behind one widget makes swapping it a one-file change
/// rather than a transcript-wide rewrite.
///
/// Only model output goes through here. A user's own text is rendered verbatim: someone
/// who types `a * b` or `_foo_` must see what they typed, not italics.
class MarkdownMessage extends StatelessWidget {
  const MarkdownMessage({super.key, required this.text, this.style});

  final String text;

  /// The surrounding bubble's text style; markdown styles are derived from it so a
  /// paragraph looks exactly like the plain text it replaced.
  final TextStyle? style;

  @override
  Widget build(BuildContext context) {
    return MarkdownBody(
      data: text,
      // Models write single newlines and mean them. CommonMark *collapses* those into
      // one paragraph, and the default here is `false` — which turns a structured answer
      // into a wall of text. This one flag is most of what makes LLM output readable.
      softLineBreak: true,
      selectable: true,
      styleSheet: _styleSheet(context),
      builders: {
        'pre': CodeBlockBuilder(textStyle: _codeStyle(context)),
        'latex': LatexMathBuilder(textStyle: style),
      },
      // `CodeSyntax` first, on purpose: the parser evaluates user syntaxes before its
      // own defaults, so LaTeX would otherwise reach inside a code span and eat
      // `` `${A}${B}` `` as an equation.
      inlineSyntaxes: [md.CodeSyntax(), LatexInlineSyntax()],
      blockSyntaxes: [LatexBlockSyntax()],
      // Keep GitHub-flavoured markdown: passing an extension set replaces the default,
      // and dropping it would take tables and strikethrough with it.
      extensionSet: md.ExtensionSet.gitHubFlavored,
    );
  }

  TextStyle _codeStyle(BuildContext context) {
    final body = style ?? Theme.of(context).textTheme.bodyMedium;
    return TextStyle(
      fontFamily: 'monospace',
      fontFamilyFallback: const ['Menlo', 'Consolas', 'DejaVu Sans Mono'],
      fontSize: (body?.fontSize ?? 14) - 1,
      height: 1.4,
      color: body?.color,
    );
  }

  MarkdownStyleSheet _styleSheet(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final body = style ?? theme.textTheme.bodyMedium;
    final code = TextStyle(
      fontFamily: 'monospace',
      fontFamilyFallback: const ['Menlo', 'Consolas', 'DejaVu Sans Mono'],
      fontSize: (body?.fontSize ?? 14) - 1,
      color: body?.color,
    );

    return MarkdownStyleSheet.fromTheme(theme).copyWith(
      p: body,
      listBullet: body,
      a: TextStyle(
        color: scheme.primary,
        decoration: TextDecoration.underline,
      ),
      code: code.copyWith(backgroundColor: scheme.surfaceContainerHighest),
      blockquoteDecoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        border: Border(left: BorderSide(color: scheme.outline, width: 3)),
      ),
      // Markdown's own margins would double the bubble's padding.
      blockSpacing: 8,
      h1: theme.textTheme.titleLarge,
      h2: theme.textTheme.titleMedium,
      h3: theme.textTheme.titleSmall,
      tableBorder: TableBorder.all(color: scheme.outlineVariant, width: 1),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      // The package only wraps a table in a horizontal scroll view when the column
      // width is Fixed or Intrinsic (`builder.dart:447`) — and the default is
      // `FlexColumnWidth`, which gets no scroll at all. A wide LLM table would then
      // squash its columns or push the page sideways, which the workbench forbids.
      tableColumnWidth: const IntrinsicColumnWidth(),
    );
  }
}
