import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message_role.dart';
import 'package:nelle_agent/src/features/chat/markdown_message.dart';
import 'package:nelle_agent/src/features/chat/message_bubble.dart';

Widget _harness(Widget child) => MaterialApp(
  theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
  home: FTheme(
    data: FThemes.neutral.light.desktop,
    child: Scaffold(body: SingleChildScrollView(child: child)),
  ),
);

ConversationMessage _message(ConversationMessageRole role, String content) =>
    ConversationMessage(id: 'x', role: role, content: content, createdAt: 't');

/// The text actually painted, with markdown syntax already consumed by the renderer.
///
/// Selectable markdown is built from `SelectableText.rich`, which paints through an
/// `EditableText` rather than a `RichText` — collect both, or the assertion only ever
/// sees the list bullets.
String _rendered(WidgetTester tester) => [
  ...tester
      .widgetList<RichText>(find.byType(RichText))
      .map((rich) => rich.text.toPlainText()),
  ...tester
      .widgetList<EditableText>(find.byType(EditableText))
      .map((editable) => editable.controller.text),
].join('\n');

void main() {
  testWidgets('an assistant answer renders markdown, not its syntax', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            ConversationMessageRole.assistant,
            '**Method 1**\n\n1. First\n2. Second',
          ),
        ),
      ),
    );

    final text = _rendered(tester);
    expect(text, contains('Method 1'));
    // The asterisks are markup. Showing them is the bug this milestone exists to fix.
    expect(text, isNot(contains('**')));
  });

  testWidgets('a user turn is rendered verbatim, never as markdown', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(ConversationMessageRole.user, 'is a * b == a_b_c?'),
        ),
      ),
    );

    // Someone who types `*` and `_` must see what they typed, not italics.
    expect(_rendered(tester), contains('is a * b == a_b_c?'));
    expect(find.byType(MarkdownMessage), findsNothing);
  });

  testWidgets('softLineBreak is on: a single newline is a line break', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(const MarkdownMessage(text: 'line one\nline two')),
    );

    // CommonMark *collapses* single newlines into one paragraph, and the package
    // defaults to that. It turns a structured answer into a wall of text, and no
    // assertion about the visible string would catch it — so pin the flag.
    final body = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    expect(body.softLineBreak, isTrue);
    expect(_rendered(tester), contains('line one\nline two'));
  });

  testWidgets('a fenced code block gets its language, chrome and a copy button', (
    tester,
  ) async {
    const source = "void main() {\n  print('hi');\n}";
    await tester.pumpWidget(
      _harness(const MarkdownMessage(text: '```dart\n$source\n```')),
    );

    // The language rides on the code element as `class="language-dart"` — the
    // HTML-shaped AST showing through.
    expect(find.text('dart'), findsOneWidget);
    expect(
      find.byKey(ValueKey('k-code-copy-${source.hashCode}')),
      findsOneWidget,
    );
    expect(_rendered(tester), contains("print('hi');"));
    // The fence itself is markup, not content.
    expect(_rendered(tester), isNot(contains('```')));
  });

  testWidgets('a code block scrolls itself, so a long line cannot move the page', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(MarkdownMessage(text: '```\n${'x' * 400}\n```')),
    );

    final scroll = tester.widget<SingleChildScrollView>(
      find.byType(SingleChildScrollView).last,
    );
    expect(scroll.scrollDirection, Axis.horizontal);
  });

  testWidgets('a wide table scrolls instead of overflowing', (tester) async {
    // The package only wraps a table in a scroll view when the column width is Fixed
    // or Intrinsic; its default (FlexColumnWidth) gets none, so a wide table squashes
    // or overflows. Pin the setting that buys the scroll.
    await tester.pumpWidget(
      _harness(
        const MarkdownMessage(
          text: '| a | b |\n| --- | --- |\n| 1 | 2 |',
        ),
      ),
    );

    final body = tester.widget<MarkdownBody>(find.byType(MarkdownBody));
    expect(body.styleSheet?.tableColumnWidth, isA<IntrinsicColumnWidth>());
    expect(find.byType(Table), findsOneWidget);
  });

  testWidgets('an unchanged bubble does not re-parse when the transcript rebuilds', (
    tester,
  ) async {
    // Every SSE delta rebuilds the whole transcript, and MarkdownBody re-parses when
    // either `data` or `styleSheet` changes (`widget.dart:366`). `data` is stable for a
    // settled message — so the *style sheet* is what decides whether N messages
    // re-parse on every token. It must be value-equal across rebuilds, and it is only
    // equal if every field we set is. Break that and the transcript quietly re-parses
    // itself token by token.
    await tester.pumpWidget(_harness(const MarkdownMessage(text: 'settled')));
    final first = tester
        .widget<MarkdownBody>(find.byType(MarkdownBody))
        .styleSheet;

    await tester.pumpWidget(
      _harness(const MarkdownMessage(text: 'settled', key: Key('x'))),
    );
    final second = tester
        .widget<MarkdownBody>(find.byType(MarkdownBody))
        .styleSheet;

    expect(second, equals(first));
  });

  testWidgets('a streaming bubble coalesces deltas but never drops the last one', (
    tester,
  ) async {
    await tester.pumpWidget(_harness(const MarkdownMessage(text: 'one')));
    expect(_rendered(tester), contains('one'));

    // Deltas arrive per token. Re-parsing on each one costs up to 14 ms against a
    // 16.7 ms frame, so they are coalesced...
    for (final text in ['one two', 'one two three', 'one two three four']) {
      await tester.pumpWidget(_harness(MarkdownMessage(text: text)));
      await tester.pump(const Duration(milliseconds: 5));
    }
    expect(
      _rendered(tester),
      isNot(contains('four')),
      reason: 'every delta re-parsed; the throttle did nothing',
    );

    // ...and the last delta of a run is the one the reader actually stops on, so it
    // must still land. Dropping it would freeze the answer one token from the end.
    await tester.pump(MarkdownMessage.throttle);
    expect(_rendered(tester), contains('one two three four'));
  });

  testWidgets('an empty assistant message shows the placeholder, not markdown', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(message: _message(ConversationMessageRole.assistant, '')),
      ),
    );

    expect(find.byType(MarkdownMessage), findsNothing);
    expect(_rendered(tester), contains('…'));
  });
}
