import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../settings/attachment_settings.dart';
import 'attachment_draft.dart';

/// Turns a very long paste into a `.txt` attachment instead of forty thousand
/// characters in the input.
///
/// **The threshold is the server's** (`attachments.pasteToFileCharacters`), and until it
/// answers there is none — every paste stays in the message. The client ships no copy of
/// the default: a stale constant would silently turn someone's paste into a file against
/// a server that had disabled it.
///
/// Intercepting means *owning* the paste: a short one has to be inserted here, because
/// consuming the shortcut stops the text field from doing it. That is the same bargain
/// the web composer strikes (preventDefault plus stopPropagation, then insert).
class PasteToFile extends ConsumerWidget {
  const PasteToFile({
    super.key,
    required this.conversationId,
    required this.controller,
    required this.child,
  });

  final String conversationId;
  final TextEditingController controller;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // Warm the settings when the composer mounts, not when the paste arrives. `read` on
    // a provider nothing has watched returns AsyncLoading and merely *starts* the
    // request — so without this the threshold is unknown for the first paste, every
    // time, and the one paste anyone actually notices goes into the message instead.
    ref.watch(attachmentSettingsProvider);

    // A `Shortcuts` nearer the focused field wins over the app-level text-editing
    // shortcuts, which is what lets this run before the field pastes for itself.
    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.keyV, control: true): _PasteIntent(),
        SingleActivator(LogicalKeyboardKey.keyV, meta: true): _PasteIntent(),
      },
      child: Actions(
        actions: {
          _PasteIntent: CallbackAction<_PasteIntent>(
            onInvoke: (_) {
              _paste(ref);
              return null;
            },
          ),
        },
        child: child,
      ),
    );
  }

  Future<void> _paste(WidgetRef ref) async {
    final clipboard = await Clipboard.getData(Clipboard.kTextPlain);
    final text = clipboard?.text;
    if (text == null || text.isEmpty) {
      return;
    }

    // `valueOrNull` is null until the settings request resolves, and that is the inert
    // state on purpose: no threshold means the paste stays in the message.
    final settings =
        ref.read(attachmentSettingsProvider).valueOrNull ??
        const AttachmentSettings();

    if (settings.shouldPasteToFile(text.length)) {
      await ref
          .read(attachmentDraftProvider(conversationId).notifier)
          .addBytes(
            bytes: Uint8List.fromList(utf8.encode(text)),
            filename: 'pasted.txt',
            mimeType: 'text/plain',
          );
      return;
    }
    _insert(text);
  }

  /// Inserts [text] at the cursor, replacing any selection — what the text field would
  /// have done had we not taken the shortcut off it.
  void _insert(String text) {
    final value = controller.value;
    final selection = value.selection;
    if (!selection.isValid) {
      controller.value = TextEditingValue(
        text: value.text + text,
        selection: TextSelection.collapsed(offset: value.text.length + text.length),
      );
      return;
    }
    final replaced = value.text.replaceRange(selection.start, selection.end, text);
    controller.value = TextEditingValue(
      text: replaced,
      selection: TextSelection.collapsed(offset: selection.start + text.length),
    );
  }
}

class _PasteIntent extends Intent {
  const _PasteIntent();
}
