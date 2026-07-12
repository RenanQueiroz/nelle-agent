import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// The bytes of an attachment a past message carries.
///
/// **Fetched through the app's dio, never through `Image.network`.** That is the whole
/// reason this exists: `Image.network` opens its own HTTP client, which carries no
/// bearer token (so a paired device gets 401) and knows nothing of the pinned
/// certificate (so a self-signed server fails the handshake). It would show a broken
/// image on precisely the device this route was added for.
///
/// Cached for the life of the app: the route is content-addressed and answers
/// `immutable`, so the bytes at an id can never change. Re-fetching them every time a
/// message scrolls back into view would be pure waste.
final attachmentBytesProvider = FutureProvider.family<Uint8List?, String>((
  ref,
  id,
) async {
  final response = await ref
      .watch(dioProvider)
      .get<List<int>>(
        '/api/attachments/$id/content',
        options: Options(responseType: ResponseType.bytes),
      );
  final status = response.statusCode ?? 0;
  if (status < 200 || status >= 300 || response.data == null) {
    // A 404 is ordinary: the file may have been swept, or the attachment may be text,
    // which lives in the database and has no bytes on disk. The caller falls back to a
    // chip rather than showing an error.
    return null;
  }
  return Uint8List.fromList(response.data!);
});

/// An image from a past message, with [fallback] shown while it loads and if it cannot
/// be loaded at all.
class AttachmentImage extends ConsumerWidget {
  const AttachmentImage({
    super.key,
    required this.attachmentId,
    required this.fallback,
  });

  final String attachmentId;
  final Widget fallback;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bytes = ref.watch(attachmentBytesProvider(attachmentId));

    return switch (bytes) {
      AsyncData(:final value?) => ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 220, maxHeight: 220),
          child: Image.memory(
            value,
            fit: BoxFit.contain,
            // Degenerate bytes are still bytes. A picture that will not decode must not
            // take the transcript down with it.
            errorBuilder: (_, _, _) => fallback,
          ),
        ),
      ),
      // Loading, gone, or refused: the chip is the honest thing to show, and it is what
      // the transcript showed before this route existed.
      _ => fallback,
    };
  }
}
