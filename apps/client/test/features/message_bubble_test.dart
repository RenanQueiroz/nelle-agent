import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata_kind.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message_role.dart';
import 'package:nelle_agent/src/features/chat/message_attachments.dart';
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

  testWidgets('a sent message shows what it carried, as chips', (tester) async {
    // Chips, not thumbnails, and not by accident: a past message's bytes are not on the
    // client and no route serves them. `storagePath` is a server-local path, meaningless
    // to a phone.
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: ConversationMessage(
            id: 'm',
            role: ConversationMessageRole.user,
            content: 'look at these',
            createdAt: 't',
            attachments: [
              AttachmentMetadata(
                id: 'a1',
                conversationId: 'c',
                kind: AttachmentMetadataKind.image,
                name: 'red.png',
                sizeBytes: 168,
                createdAt: 't',
              ),
              AttachmentMetadata(
                id: 'a2',
                conversationId: 'c',
                kind: AttachmentMetadataKind.text,
                name: 'secret.txt',
                sizeBytes: 48,
                createdAt: 't',
              ),
            ],
          ),
        ),
      ),
    );

    expect(find.byKey(const ValueKey('k-msg-attachment-a1')), findsOneWidget);
    expect(find.byKey(const ValueKey('k-msg-attachment-a2')), findsOneWidget);
    expect(find.text('red.png'), findsOneWidget);
    expect(find.text('secret.txt'), findsOneWidget);
    expect(find.text('168 B'), findsOneWidget);
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('a message with no attachments shows no chip row', (tester) async {
    await tester.pumpWidget(
      _harness(
        const MessageBubble(
          message: ConversationMessage(
            id: 'm',
            role: ConversationMessageRole.user,
            content: 'plain',
            createdAt: 't',
          ),
        ),
      ),
    );

    expect(find.byType(MessageAttachments), findsOneWidget);
    expect(tester.getSize(find.byType(MessageAttachments)), Size.zero);
  });
}
