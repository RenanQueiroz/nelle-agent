import 'package:flutter/material.dart';
import 'package:forui/forui.dart';

import '../../api/generated/models/attachment_metadata.dart';
import '../../api/generated/models/attachment_metadata_kind.dart';
import 'attachment_image.dart';

/// What a sent message carried.
///
/// An **image** shows the picture, fetched from `GET /api/attachments/:id/content`. A
/// past message's bytes are not on the client and never were -- the composer can preview
/// an image only because it just read those bytes off disk -- so until that route existed
/// a chip was the only honest thing to render. It exists now, and it exists *because* of
/// the phone: a client that cannot show you the photo you sent yesterday is not much of a
/// client.
///
/// Everything else stays a chip. A PDF has no thumbnail worth 220 pixels and a text file
/// has none at all, and the chip already says the name, the size, and the kind.
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
            if (attachment.kind == AttachmentMetadataKind.image)
              AttachmentImage(
                key: ValueKey('k-msg-attachment-image-${attachment.id}'),
                attachmentId: attachment.id,
                // Shown while the bytes are in flight, and if they never arrive: the
                // file may have been swept, and a broken-image icon would say less than
                // the name and size already do.
                fallback: _Chip(
                  key: ValueKey('k-msg-attachment-${attachment.id}'),
                  attachment: attachment,
                ),
              )
            else
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
