import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message_role.dart';
import 'package:nelle_agent/src/features/chat/message_bubble.dart';

ConversationMessage _message({
  required ConversationMessageRole role,
  required String content,
  String? reasoning,
  String? variantLabel,
  String? modelAliasSnapshot,
}) => ConversationMessage(
  id: 'x',
  role: role,
  content: content,
  createdAt: 't',
  reasoning: reasoning,
  variantLabel: variantLabel,
  modelAliasSnapshot: modelAliasSnapshot,
);

Widget _harness(Widget child) => MaterialApp(
  theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
  home: FTheme(
    data: FThemes.neutral.light.desktop,
    child: Scaffold(body: SingleChildScrollView(child: child)),
  ),
);

void main() {
  testWidgets('renders user and assistant content', (tester) async {
    await tester.pumpWidget(
      _harness(
        Column(
          children: [
            MessageBubble(
              message: _message(
                role: ConversationMessageRole.user,
                content: 'Hi there',
              ),
            ),
            MessageBubble(
              message: _message(
                role: ConversationMessageRole.assistant,
                content: 'Answer',
              ),
            ),
          ],
        ),
      ),
    );

    expect(find.text('Hi there'), findsOneWidget);
    expect(find.text('Answer'), findsOneWidget);
  });

  testWidgets('reasoning is collapsed by default and expands on tap', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'A',
            reasoning: 'because reasons',
          ),
        ),
      ),
    );

    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.text('because reasons'), findsNothing);

    await tester.tap(find.text('Reasoning'));
    await tester.pump();

    expect(find.text('because reasons'), findsOneWidget);
  });

  testWidgets('shows the model + variant footer', (tester) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'A',
            variantLabel: 'variant 2/3',
            modelAliasSnapshot: 'gemma',
          ),
        ),
      ),
    );

    expect(find.textContaining('variant 2/3'), findsOneWidget);
    expect(find.textContaining('gemma'), findsOneWidget);
  });
}
