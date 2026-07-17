import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:forui/forui.dart';
import 'package:nelle_agent/src/api/api_client.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata.dart';
import 'package:nelle_agent/src/api/generated/models/attachment_metadata_kind.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message.dart';
import 'package:nelle_agent/src/api/generated/models/conversation_message_role.dart';
import 'package:nelle_agent/src/features/chat/footer_bar.dart';
import 'package:nelle_agent/src/features/chat/message_attachments.dart';
import 'package:nelle_agent/src/features/chat/message_bubble.dart';
import 'package:nelle_agent/src/features/chat/performance_stats.dart';

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

  testWidgets('a reading row under a user turn shows tokens, time and speed', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.user,
            content: 'Hi',
          ),
          readingMetric: const PerfMetric(tokens: 22, milliseconds: 200),
        ),
      ),
    );

    expect(find.text('22 tokens'), findsOneWidget);
    expect(find.text('0.2s'), findsOneWidget);
    // 22 tokens / 200ms = 110 tokens/s, and the reading row spells the unit "tokens/s".
    expect(find.text('110.00 tokens/s'), findsOneWidget);
    expect(find.byKey(const ValueKey('k-msg-reading-x')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('a generation row in the assistant footer uses t/s', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'Hello!',
            modelAliasSnapshot: 'gemma',
          ),
          generationMetric: const PerfMetric(
            tokens: 281,
            tokensPerSecond: 40.25,
            milliseconds: 7000,
          ),
        ),
      ),
    );

    expect(find.text('281 tokens'), findsOneWidget);
    expect(find.text('7.0s'), findsOneWidget);
    expect(find.text('40.25 t/s'), findsOneWidget);
    expect(find.byKey(const ValueKey('k-msg-generation-x')), findsOneWidget);
    // The model alias still renders beside the stats.
    expect(find.text('gemma'), findsOneWidget);
  });

  testWidgets('the speed badge is dropped when the burst was untimeable', (
    tester,
  ) async {
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(role: ConversationMessageRole.user, content: 'Hi'),
          // A frame llama.cpp could not time: bytes but no honest rate.
          readingMetric: const PerfMetric(tokens: 79, milliseconds: 0.003),
        ),
      ),
    );

    expect(find.text('79 tokens'), findsOneWidget);
    expect(find.textContaining('tokens/s'), findsNothing);
    expect(find.textContaining('t/s'), findsNothing);
  });

  testWidgets('assistant footer stacks its sections on a phone, without overflowing', (
    tester,
  ) async {
    // A phone-width window: the alias + three stat badges + the action icon must stack
    // instead of overflowing (the 91px composer-overflow lesson) — and `FooterBar` drops the
    // `·` separators when it stacks.
    tester.view.physicalSize = const Size(360, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'Hello!',
            modelAliasSnapshot: 'unsloth/gemma-4-12B-it-qat-GGUF:UD-Q4_K_XL',
          ),
          generationMetric: const PerfMetric(
            tokens: 281,
            tokensPerSecond: 40.25,
            milliseconds: 7000,
          ),
          onRegenerate: () {},
          onFork: () {},
        ),
      ),
    );

    expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
    expect(find.text('40.25 t/s'), findsOneWidget);
    expect(find.byKey(const ValueKey('k-msg-regenerate-x')), findsOneWidget);
    final footer = tester.renderObject<RenderFooterBar>(
      find.byKey(const ValueKey('k-msg-footer-x')),
    );
    expect(footer.isRow, isFalse, reason: 'a narrow footer stacks, no separators');
  });

  testWidgets('a wide assistant footer lays its sections in one row', (
    tester,
  ) async {
    // The default 800px test window is wide enough for a short alias + stats + action to share
    // one line, which is when the `·` separators appear.
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'Hi',
            modelAliasSnapshot: 'gemma',
          ),
          generationMetric: const PerfMetric(tokens: 12, milliseconds: 300),
          onRegenerate: () {},
        ),
      ),
    );

    final footer = tester.renderObject<RenderFooterBar>(
      find.byKey(const ValueKey('k-msg-footer-x')),
    );
    expect(footer.isRow, isTrue);
  });

  testWidgets('the model section is a dropdown when one is injected, else plain text', (
    tester,
  ) async {
    // Injected control (the transcript passes the real dropdown only when regenerate is
    // allowed): the footer shows it, not the alias text.
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'Hi',
            modelAliasSnapshot: 'gemma',
            variantLabel: 'variant 2/2',
          ),
          modelControl: const Text('gemma', key: ValueKey('k-test-model-control')),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('k-test-model-control')), findsOneWidget);
    // The variant label still rides beside the control.
    expect(find.text('variant 2/2'), findsOneWidget);

    // No control: the alias renders as plain text (a run in flight, or a pending turn).
    await tester.pumpWidget(
      _harness(
        MessageBubble(
          message: _message(
            role: ConversationMessageRole.assistant,
            content: 'Hi',
            modelAliasSnapshot: 'gemma',
            variantLabel: 'variant 2/2',
          ),
        ),
      ),
    );
    expect(find.byKey(const ValueKey('k-test-model-control')), findsNothing);
    expect(find.text('gemma · variant 2/2'), findsOneWidget);
  });
}
