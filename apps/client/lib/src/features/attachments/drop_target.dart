import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'attachment_draft.dart';

/// Files dropped onto the chat become attachments.
///
/// `desktop_drop` is a plain platform-channel plugin. The obvious pairing for
/// `super_clipboard` — `super_drag_and_drop` — is a **dead end**: both sit on cargokit,
/// which is archived and cannot build under Gradle 9, so the Android build could not be
/// fixed by waiting.
class AttachmentDropTarget extends ConsumerStatefulWidget {
  const AttachmentDropTarget({
    super.key,
    required this.conversationId,
    required this.child,
  });

  final String conversationId;
  final Widget child;

  @override
  ConsumerState<AttachmentDropTarget> createState() =>
      _AttachmentDropTargetState();
}

class _AttachmentDropTargetState extends ConsumerState<AttachmentDropTarget> {
  bool _hovering = false;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return DropTarget(
      onDragEntered: (_) => setState(() => _hovering = true),
      onDragExited: (_) => setState(() => _hovering = false),
      onDragDone: (details) async {
        setState(() => _hovering = false);
        final draft = ref.read(
          attachmentDraftProvider(widget.conversationId).notifier,
        );
        for (final file in details.files) {
          // One at a time, so a refusal names the file that caused it and the others
          // still land. The server does the classifying and the refusing.
          await draft.addFile(
            path: file.path,
            filename: file.name,
            mimeType: file.mimeType,
          );
        }
      },
      child: Stack(
        children: [
          widget.child,
          if (_hovering)
            Positioned.fill(
              child: IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: scheme.primary.withValues(alpha: 0.08),
                    border: Border.all(color: scheme.primary, width: 2),
                  ),
                  child: Center(
                    child: Text(
                      'Drop to attach',
                      style: TextStyle(
                        color: scheme.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
