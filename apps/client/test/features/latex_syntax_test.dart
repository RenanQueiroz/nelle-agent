import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:nelle_agent/src/features/chat/latex_syntax.dart';

/// Parses exactly as `MarkdownMessage` does — `CodeSyntax` ahead of LaTeX.
String _html(String source) => md.markdownToHtml(
  source,
  inlineSyntaxes: [md.CodeSyntax(), LatexInlineSyntax()],
  blockSyntaxes: [],
  extensionSet: md.ExtensionSet.gitHubFlavored,
);

/// The equations the parser actually found.
List<String> _equations(String source) => RegExp(r'<latex[^>]*>(.*?)</latex>')
    .allMatches(_html(source))
    .map((m) => m.group(1)!)
    .toList();

void main() {
  group('real LaTeX is rendered', () {
    test(r'inline $…$ and display $$…$$, as gemma actually writes them', () {
      expect(_equations(r'The cost is $O(n^2)$ here.'), [r'O(n^2)']);
      expect(_equations(r'So $$17 \times 20 = 340$$ follows.'), [
        r'17 \times 20 = 340',
      ]);
      expect(_equations(r'Both $O(n \log n)$ avg / $O(n^2)$ worst'), [
        r'O(n \log n)',
        r'O(n^2)',
      ]);
    });

    test(r'\(…\) and \[…\]', () {
      expect(_equations(r'inline \(a + b\) done'), ['a + b']);
      expect(_equations(r'display \[a + b\] done'), ['a + b']);
    });
  });

  group('a dollar sign is not automatically maths', () {
    test('prices are left alone', () {
      // The killer case: "5 and " ends in a space, so the closing `$` is not a closing
      // delimiter — and the digit guard catches the rest.
      expect(_equations(r'It costs $5 and $10 in total.'), isEmpty);
      expect(_equations(r'Prices: $5, $10, $20.'), isEmpty);
      expect(_equations(r'It costs $5.'), isEmpty);
    });

    test('shell variables in prose are left alone', () {
      expect(_equations(r'Set $HOME and $PATH before running.'), isEmpty);
      expect(_equations(r'echo $HOME'), isEmpty);
    });

    test('a code span is never read as maths', () {
      // `CodeSyntax` runs first, so LaTeX never reaches inside the backticks. Without
      // that ordering this is parsed as an equation and the code span is destroyed.
      expect(_equations(r'Run `echo ${A}${B}` now.'), isEmpty);
      expect(_html(r'Run `echo ${A}${B}` now.'), contains('<code>'));
    });

    test('a fenced code block is never read as maths', () {
      expect(_equations('```sh\n' r'export A=$X' '\n' r'echo $Y $Z' '\n```'), isEmpty);
    });
  });

  group('the delimiters we deliberately dropped', () {
    test('parentheses and brackets in prose stay prose', () {
      // The addon's own LatexInlineSyntax treats `( x )` and `[ x ]` as maths, which
      // turns an ordinary sentence into an equation. This is why we do not use it.
      expect(_equations('the result ( see above ) is 391'), isEmpty);
      expect(_equations('the note [ see above ] is 391'), isEmpty);
    });
  });
}
