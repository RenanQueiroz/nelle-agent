import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata_kind.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message_role.dart';
import 'package:nelle_agent/src/features/chat/message_attachments.dart';
import 'package:nelle_agent/src/features/chat/message_bubble.dart';

import '../helpers/fake_dio.dart';

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

/// A ProviderScope is required now that an image attachment fetches its own bytes
/// (`GET /api/attachments/:id/content`). The stub answers 404, so the image falls back
/// to its chip -- which is what these tests assert on, and is the honest behaviour when
/// the bytes are gone.
Widget _harness(Widget child) => ProviderScope(
  overrides: [
    dioProvider.overrideWith(
      (ref) => stubDio(
        (options) => jsonResponse({
          'error': {'code': 'not_found'},
        }, status: 404),
      ),
    ),
  ],
  child: MaterialApp(
    theme: FThemes.neutral.light.desktop.toApproximateMaterialTheme(),
    home: FTheme(
      data: FThemes.neutral.light.desktop,
      child: Scaffold(body: SingleChildScrollView(child: child)),
    ),
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

  testWidgets('a sent message shows an image as a picture and a text file as a chip', (
    tester,
  ) async {
    // M4 rendered *everything* as a chip, deliberately: a past message's bytes are not
    // on the client and no route served them. `GET /api/attachments/:id/content` exists
    // now (M5 T7), added for the phone -- a client that cannot show you the photo you
    // sent yesterday is not much of a client. So an image is a picture again.
    //
    // Everything else stays a chip. A PDF has no thumbnail worth 220 pixels and a text
    // file has none at all, and fetching either to draw a chip is a request for nothing.
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
    await tester.pumpAndSettle();

    // The image is fetched; until the bytes arrive (and if they never do) it falls back
    // to the chip, which is what this harness's stub dio produces.
    expect(
      find.byKey(const ValueKey('k-msg-attachment-image-a1')),
      findsOneWidget,
    );
    // The text file was never fetched and is a chip, with its name and size.
    expect(find.byKey(const ValueKey('k-msg-attachment-a2')), findsOneWidget);
    expect(find.text('secret.txt'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a message with no attachments shows no chip row', (
    tester,
  ) async {
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
