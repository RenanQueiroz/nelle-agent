import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_exception.dart';
import '../../api/generated/models/upload_response.dart';
import '../../api/generated/models/upload_response_kind.dart';
import 'upload_repository.dart';

/// One staged attachment: what the server said, plus where the bytes came from.
///
/// The source is kept only so an image chip can show a thumbnail — and it is kept as a
/// *path* wherever there is one, so a 25 MiB photo is not also held in memory. Flutter
/// decodes it lazily. Pasted bytes have no path, so those we keep.
class StagedAttachment {
  const StagedAttachment({
    required this.upload,
    this.previewPath,
    this.previewBytes,
  });

  final UploadResponse upload;
  final String? previewPath;
  final Uint8List? previewBytes;

  String get uploadId => upload.uploadId;
  bool get isImage => upload.kind == UploadResponseKind.image;

  /// A PDF the server could extract no text from: it reaches the model as page images,
  /// which cost roughly 1200 context tokens each. The chip has to say so.
  bool get isScan =>
      upload.kind == UploadResponseKind.pdf && upload.hasTextLayer == false;
}

/// The attachments staged for one conversation's next message.
class AttachmentDraft {
  const AttachmentDraft({
    this.uploads = const [],
    this.uploading = 0,
    this.error,
  });

  /// Uploaded and waiting to be sent. Each already exists on the server, unbound.
  final List<StagedAttachment> uploads;

  /// How many are still in flight, so the composer can say so without blocking.
  final int uploading;

  /// The server's own sentence for the last refusal — it names the file and says why
  /// (too large, binary posing as text, an image a proven text-only model cannot see).
  final String? error;

  bool get isEmpty => uploads.isEmpty && uploading == 0;

  /// The wire form: a chat request carries `{uploadId}` and nothing else.
  List<String> get uploadIds => [for (final staged in uploads) staged.uploadId];

  AttachmentDraft copyWith({
    List<StagedAttachment>? uploads,
    int? uploading,
    String? error,
    bool clearError = false,
  }) => AttachmentDraft(
    uploads: uploads ?? this.uploads,
    uploading: uploading ?? this.uploading,
    error: clearError ? null : (error ?? this.error),
  );
}

/// Staged attachments, **per conversation**.
///
/// Keyed by conversation because the model is: an image is gated on the model *that
/// chat* will answer with, so a file staged in one chat has no business appearing in
/// another. Switching conversations must leave both drafts where they were.
///
/// The uploads live on the server the moment they are added, which is what makes a
/// refusal cheap: a message the server rejected before it became a turn leaves the text
/// *and* these chips exactly where they were — the bytes are still up there, unbound.
class AttachmentDraftNotifier extends FamilyNotifier<AttachmentDraft, String> {
  @override
  AttachmentDraft build(String conversationId) => const AttachmentDraft();

  Future<void> addFile({
    required String path,
    required String filename,
    String? mimeType,
  }) => _add(
    () => ref
        .read(uploadRepositoryProvider)
        .uploadFile(
          path: path,
          filename: filename,
          conversationId: arg,
          mimeType: mimeType,
        ),
    previewPath: path,
  );

  Future<void> addBytes({
    required Uint8List bytes,
    required String filename,
    String? mimeType,
  }) => _add(
    () => ref
        .read(uploadRepositoryProvider)
        .uploadBytes(
          bytes: bytes,
          filename: filename,
          conversationId: arg,
          mimeType: mimeType,
        ),
    previewBytes: bytes,
  );

  Future<void> _add(
    Future<UploadResponse> Function() upload, {
    String? previewPath,
    Uint8List? previewBytes,
  }) async {
    state = state.copyWith(uploading: state.uploading + 1, clearError: true);
    try {
      final uploaded = await upload();
      state = state.copyWith(
        uploads: [
          ...state.uploads,
          StagedAttachment(
            upload: uploaded,
            previewPath: previewPath,
            previewBytes: previewBytes,
          ),
        ],
        uploading: state.uploading - 1,
      );
    } on NelleApiException catch (e) {
      // The server's sentence names the file and says why. Ours would not.
      state = state.copyWith(uploading: state.uploading - 1, error: e.message);
    } catch (e) {
      state = state.copyWith(uploading: state.uploading - 1, error: '$e');
    }
  }

  /// Removes a chip **and deletes the upload**, rather than leaving it for the server's
  /// 24h sweep. The user said they did not want it.
  Future<void> remove(String uploadId) async {
    state = state.copyWith(
      uploads: [
        for (final staged in state.uploads)
          if (staged.uploadId != uploadId) staged,
      ],
      clearError: true,
    );
    await ref.read(uploadRepositoryProvider).delete(uploadId);
  }

  /// Empties the draft **without deleting anything**: these uploads are now bound to a
  /// message and belong to it. Called when the run starts, never before — a message the
  /// server refused keeps its chips.
  void clear() {
    state = const AttachmentDraft();
  }

  void clearError() {
    state = state.copyWith(clearError: true);
  }
}

final attachmentDraftProvider =
    NotifierProvider.family<AttachmentDraftNotifier, AttachmentDraft, String>(
      AttachmentDraftNotifier.new,
    );
