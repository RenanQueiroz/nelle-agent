import 'package:markdown/markdown.dart' as md;

/// Inline LaTeX, with delimiters a coding agent can live with.
///
/// **This deliberately replaces `flutter_markdown_plus_latex`'s own
/// `LatexInlineSyntax`.** That one treats `( x )` and `[ x ]` as math delimiters, so an
/// ordinary sentence — "the result ( see above ) is 391" — is parsed as an equation and
/// handed to a math renderer. It also carries `\ce{}`/`\pu{}` chemistry, which no model
/// answering about code will ever emit. We keep the four delimiters that are actually
/// LaTeX and drop the liability.
///
/// The `$…$` rule is guarded the way KaTeX guards it, because a shell and a price tag
/// both use `$`:
/// - no whitespace just inside either delimiter, so `"$5 and $10"` (content `"5 and "`,
///   which ends in a space) is **not** math;
/// - the closing `$` may not be followed by a digit, which kills the rest of the
///   currency cases;
/// - a `$` may not be adjacent to another `$` here — `$$…$$` is matched first.
///
/// Code spans are protected separately, by putting `md.CodeSyntax()` *ahead* of this in
/// `inlineSyntaxes`: the parser evaluates user syntaxes before its own defaults ("User
/// specified syntaxes are the first syntaxes to be evaluated", `inline_parser.dart:62`),
/// so without that, `` `${A}${B}` `` in a code span would be eaten as math.
class LatexInlineSyntax extends md.InlineSyntax {
  LatexInlineSyntax() : super(_pattern);

  // Ordered: `$$` must be tried before `$`, or the display form is read as two empty
  // inline equations. Group 1-2 are display, 3-4 are inline.
  static const _pattern =
      r'\$\$((?:\\.|[^\\\n])+?)\$\$'
      r'|\\\[((?:\\.|[^\\\n])+?)\\\]'
      r'|\\\(((?:\\.|[^\\\n])+?)\\\)'
      r'|\$(?!\s)((?:\\.|[^\\\n$])+?)(?<!\s)\$(?!\d)';

  @override
  bool onMatch(md.InlineParser parser, Match match) {
    for (var group = 1; group <= 4; group += 1) {
      final equation = match.group(group);
      if (equation == null) {
        continue;
      }
      final element = md.Element.text('latex', equation);
      element.attributes['MathStyle'] = group <= 2 ? 'display' : 'text';
      parser.addNode(element);
      return true;
    }
    return false;
  }
}
