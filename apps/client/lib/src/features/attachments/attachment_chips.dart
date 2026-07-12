import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/upload_response_kind.dart';
import 'attachment_draft.dart';

/// The composer's attachment drawer.
///
/// **Renders only when something is attached** — an empty row of chrome above every
/// message is noise. It is also where the server's own refusal appears: that sentence
/// names the file and says why, and ours would not.
class AttachmentChips extends ConsumerWidget {
  const AttachmentChips({super.key, required this.conversationId});

  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final draft = ref.watch(attachmentDraftProvider(conversationId));
    if (draft.isEmpty && draft.error == null) {
      return const SizedBox.shrink();
    }
    final scheme = Theme.of(context).colorScheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (draft.error != null)
            Padding(
              key: const ValueKey('k-composer-attach-error'),
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                children: [
                  Icon(FLucideIcons.circleX, size: 14, color: scheme.error),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      draft.error!,
                      style: TextStyle(fontSize: 12, color: scheme.error),
                    ),
                  ),
                ],
              ),
            ),
          if (!draft.isEmpty)
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                for (final staged in draft.uploads)
                  _Chip(
                    key: ValueKey('k-composer-chip-${staged.uploadId}'),
                    staged: staged,
                    onRemove: () => ref
                        .read(attachmentDraftProvider(conversationId).notifier)
                        .remove(staged.uploadId),
                  ),
                for (var i = 0; i < draft.uploading; i += 1) const _Uploading(),
              ],
            ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.staged, required this.onRemove});

  final StagedAttachment staged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final upload = staged.upload;
    // The server may have downscaled the image or truncated the text. It said so, and
    // the user is entitled to know what is actually being sent.
    final notes = [
      if (staged.isScan) 'scan — sent as ${upload.pageCount ?? 1} page image(s)',
      ...upload.warnings,
    ];

    return Container(
      constraints: const BoxConstraints(maxWidth: 280),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: scheme.outlineVariant),
      ),
      padding: const EdgeInsets.fromLTRB(6, 4, 2, 4),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Preview(staged: staged),
          const SizedBox(width: 6),
          Flexible(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  upload.name,
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  style: const TextStyle(fontSize: 12),
                ),
                Text(
                  [_size(upload.sizeBytes), ...notes].join(' · '),
                  overflow: TextOverflow.ellipsis,
                  maxLines: 1,
                  // Legible, not decorative: "scan — sent as 6 page image(s)" is how
                  // someone learns this costs ~1200 context tokens a page, and a washed
                  // out tertiary is a note nobody reads.
                  style: TextStyle(
                    fontSize: 10,
                    color: notes.isEmpty
                        ? scheme.outline
                        : scheme.onSurfaceVariant,
                    fontWeight: notes.isEmpty ? null : FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          GestureDetector(
            key: ValueKey('k-composer-chip-remove-${staged.uploadId}'),
            behavior: HitTestBehavior.opaque,
            onTap: onRemove,
            child: Padding(
              padding: const EdgeInsets.all(6),
              child: Icon(FLucideIcons.x, size: 12, color: scheme.outline),
            ),
          ),
        ],
      ),
    );
  }

  String _size(int bytes) {
    if (bytes < 1024) {
      return '$bytes B';
    }
    if (bytes < 1024 * 1024) {
      return '${(bytes / 1024).toStringAsFixed(0)} KB';
    }
    return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
  }
}

/// An image chip shows the picture. This is free here and only here: the client just
/// read those bytes. A *past* message's bytes are not on the client, and no route serves
/// them — which is why the transcript renders chips, not thumbnails.
class _Preview extends StatelessWidget {
  const _Preview({required this.staged});

  final StagedAttachment staged;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (staged.isImage) {
      final image = staged.previewBytes != null
          ? Image.memory(staged.previewBytes!, fit: BoxFit.cover)
          : staged.previewPath != null
          ? Image.file(File(staged.previewPath!), fit: BoxFit.cover)
          : null;
      if (image != null) {
        return ClipRRect(
          borderRadius: BorderRadius.circular(4),
          child: SizedBox(width: 28, height: 28, child: image),
        );
      }
    }
    return Icon(_icon, size: 16, color: scheme.outline);
  }

  IconData get _icon => switch (staged.upload.kind) {
    UploadResponseKind.image => FLucideIcons.image,
    UploadResponseKind.pdf => FLucideIcons.fileText,
    UploadResponseKind.text => FLucideIcons.fileCode,
    UploadResponseKind.$unknown => FLucideIcons.file,
  };
}

class _Uploading extends StatelessWidget {
  const _Uploading();

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('k-composer-chip-uploading'),
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(8),
    ),
    child: const SizedBox(
      width: 14,
      height: 14,
      child: CircularProgressIndicator(strokeWidth: 2),
    ),
  );
}
