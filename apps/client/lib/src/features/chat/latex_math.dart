import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:markdown/markdown.dart' as md;

/// Renders a `latex` element produced by [LatexInlineSyntax] or the addon's block syntax.
///
/// **Replaces the addon's own `LatexElementBuilder`**, which has two faults an LLM
/// transcript hits immediately:
///
/// 1. It wraps *every* equation — inline ones included — in a horizontal
///    `SingleChildScrollView`. That is greedy for width, and flutter_markdown lays inline
///    children out in a `Wrap`, so a single `$x$` mid-sentence consumed the rest of the
///    line and threw the following words onto the next one. Inline maths must be as wide
///    as it is and no wider; only *display* maths gets a scroller, and it needs one,
///    because a long equation must scroll rather than overflow.
/// 2. It has no error fallback. LaTeX from a model is untrusted input — a half-streamed
///    or simply wrong equation makes flutter_math paint a red error box. Showing the raw
///    text the model wrote is both more honest and less alarming.
///
/// **Known limitation.** flutter_markdown lays inline children out in a `Wrap`, not as
/// `WidgetSpan`s inside one `RichText`, so the text *after* an inline equation is an
/// atomic item: it cannot re-flow word-by-word around the maths and instead begins on the
/// next line when it does not fit. Short runs (`… of $23$ (which is $20$): $17 \times 20
/// = 340$`) look right; a long sentence after `$x$` gets an early line break. This is the
/// package's inline model, not something a builder can fix. If it ever grates, the
/// escape hatch is the whole point of `MarkdownMessage`: `gpt_markdown` composes maths as
/// spans and would flow correctly — at the cost of the `syntaxHighlighter` hook.
class LatexMathBuilder extends MarkdownElementBuilder {
  LatexMathBuilder({this.textStyle});

  final TextStyle? textStyle;

  @override
  Widget visitElementAfterWithContext(
    BuildContext context,
    md.Element element,
    TextStyle? preferredStyle,
    TextStyle? parentStyle,
  ) {
    final equation = element.textContent;
    if (equation.isEmpty) {
      return const SizedBox.shrink();
    }
    final style = textStyle ?? parentStyle ?? preferredStyle;
    final display = element.attributes['MathStyle'] == 'display';

    final math = Math.tex(
      equation,
      textStyle: style,
      mathStyle: display ? MathStyle.display : MathStyle.text,
      // Not every `$…$` a model writes is valid LaTeX. Show what it wrote.
      onErrorFallback: (_) => Text(equation, style: style),
    );

    return display
        ? SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            clipBehavior: Clip.antiAlias,
            child: math,
          )
        : math;
  }
}
