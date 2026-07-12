import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/attachment_metadata.dart';
import '../../api/generated/models/attachment_metadata_kind.dart';

/// What a sent message carried, rendered as chips.
///
/// **Chips, not thumbnails, and not by accident.** A past message's bytes are not on the
/// client, and no route on the server serves them — `AttachmentMetadata.storagePath` is a
/// server-local filesystem path, meaningless to a phone. Showing the picture again needs
/// a `GET /api/attachments/:id/content` that does not exist yet, and it belongs with the
/// mobile work, which needs it for the same reason. `apps/web` renders chips too.
class MessageAttachments extends StatelessWidget {
  const MessageAttachments({super.key, required this.attachments});

  final List<AttachmentMetadata> attachments;

  @override
  Widget build(BuildContext context) {
    if (attachments.isEmpty) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Wrap(
        spacing: 4,
        runSpacing: 4,
        alignment: WrapAlignment.end,
        children: [
          for (final attachment in attachments)
            _Chip(
              key: ValueKey('k-msg-attachment-${attachment.id}'),
              attachment: attachment,
            ),
        ],
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({super.key, required this.attachment});

  final AttachmentMetadata attachment;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final size = attachment.sizeBytes;
    return Container(
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: scheme.outlineVariant),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(_icon, size: 12, color: scheme.outline),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 180),
            child: Text(
              attachment.name,
              overflow: TextOverflow.ellipsis,
              maxLines: 1,
              style: const TextStyle(fontSize: 11),
            ),
          ),
          if (size != null) ...[
            const SizedBox(width: 4),
            Text(
              _size(size),
              style: TextStyle(fontSize: 10, color: scheme.outline),
            ),
          ],
        ],
      ),
    );
  }

  IconData get _icon => switch (attachment.kind) {
    AttachmentMetadataKind.image => FLucideIcons.image,
    AttachmentMetadataKind.pdf => FLucideIcons.fileText,
    AttachmentMetadataKind.text => FLucideIcons.fileCode,
    AttachmentMetadataKind.$unknown => FLucideIcons.file,
  };

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
