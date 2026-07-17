import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../chat/chat_controller.dart';
import 'attachment_draft.dart';

/// Text, PDF and image extensions the server will classify. Anything else is refused at
/// upload with a sentence that names the file, so this is a convenience, not the gate.
const _typeGroups = [
  XTypeGroup(
    label: 'Text, PDF, images',
    extensions: [
      'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml',
      'yaml', 'yml', 'toml', 'ini', 'sql', //
      'pdf', //
      'png', 'jpg', 'jpeg', 'webp', 'gif',
    ],
  ),
];

/// Attaches files to the next message.
///
/// The image affordance follows `canAttachImages`, which is a **tri-state**: `null`
/// means llama.cpp has never reported this model's props, and on a fresh install *no*
/// model has been loaded — so `null` must not hide the button. Only a model proven
/// text-only (`false`) drops images from the picker, and even then the server is the
/// authority: it refuses at upload, by name.
class AttachButton extends ConsumerWidget {
  const AttachButton({super.key, required this.conversationId});

  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FButton.icon(
      key: const ValueKey('k-composer-attach'),
      onPress: () => _pick(context, ref),
      child: const Icon(FLucideIcons.paperclip),
    );
  }

  Future<void> _pick(BuildContext context, WidgetRef ref) async {
    final List<XFile> files;
    try {
      files = await openFiles(acceptedTypeGroups: _typeGroups);
    } catch (error) {
      // The picker itself failed — a platform error, or (the case that sent us here) the macOS
      // App Sandbox refusing the open panel for want of the user-selected-file entitlement.
      // Without this it is an invisible unhandled async exception: the button appears to do
      // nothing. Upload failures need no toast here — the draft surfaces those on the chip.
      if (context.mounted) {
        showFToast(
          context: context,
          icon: const Icon(FLucideIcons.circleX),
          title: Text('Could not open the file picker: $error'),
        );
      }
      return;
    }
    final draft = ref.read(attachmentDraftProvider(conversationId).notifier);
    for (final file in files) {
      // Uploaded one at a time, so a refusal names the file that caused it and the
      // others still land.
      await draft.addFile(
        path: file.path,
        filename: file.name,
        mimeType: file.mimeType,
      );
    }
  }
}

/// Whether the composer should offer images at all: only a model llama.cpp has *proven*
/// cannot see them says no.
bool canOfferImages(WidgetRef ref, String conversationId) {
  final chat = ref.watch(chatControllerProvider(conversationId)).valueOrNull;
  return chat?.snapshot.capabilities.canAttachImages != false;
}
