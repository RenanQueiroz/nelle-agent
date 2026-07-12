import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/api_exception.dart';
import '../../api/generated/models/upload_response.dart';

/// Uploads bytes and gets back an id.
///
/// Attachments are **uploaded, not embedded**: a chat request carries `{uploadId}` and
/// nothing else. The request is `multipart/form-data` — a `file`, plus the
/// `conversationId`, which is what the server gates images on (it asks *that*
/// conversation's model whether it can see).
class UploadRepository {
  UploadRepository(this._dio);

  final Dio _dio;

  /// Uploads a file from disk. Streamed rather than read into memory: the per-file
  /// limit is 25 MiB and a phone should not hold that twice.
  Future<UploadResponse> uploadFile({
    required String path,
    required String filename,
    required String conversationId,
    String? mimeType,
  }) => _upload(
    conversationId: conversationId,
    file: MultipartFile.fromFileSync(
      path,
      filename: filename,
      contentType: _mediaType(mimeType),
    ),
  );

  /// Uploads bytes we already hold — a long paste turned into a `.txt`, or an image off
  /// the clipboard, neither of which has a path.
  Future<UploadResponse> uploadBytes({
    required Uint8List bytes,
    required String filename,
    required String conversationId,
    String? mimeType,
  }) => _upload(
    conversationId: conversationId,
    file: MultipartFile.fromBytes(
      bytes,
      filename: filename,
      contentType: _mediaType(mimeType),
    ),
  );

  /// Deletes an upload the user removed from the composer, rather than leaving it for
  /// the server's 24h sweep. Only an *unbound* upload can be deleted; one that was sent
  /// belongs to a message and goes with its conversation.
  Future<void> delete(String uploadId) async {
    try {
      await _dio.delete<void>('/api/uploads/${Uri.encodeComponent(uploadId)}');
    } on DioException catch (e) {
      // A 404 means it was already swept or already bound. Either way it is not ours to
      // worry about, and the chip is going away regardless.
      if (e.response?.statusCode != 404) {
        throw NelleApiException.network(e);
      }
    }
  }

  DioMediaType? _mediaType(String? mimeType) {
    if (mimeType == null || !mimeType.contains('/')) {
      return null;
    }
    try {
      return DioMediaType.parse(mimeType);
    } catch (_) {
      // A mime type the server will re-derive from the filename anyway.
      return null;
    }
  }

  Future<UploadResponse> _upload({
    required String conversationId,
    required MultipartFile file,
  }) async {
    final Response<Map<String, dynamic>> res;
    try {
      res = await _dio.post<Map<String, dynamic>>(
        '/api/uploads',
        data: FormData.fromMap({
          'conversationId': conversationId,
          'file': file,
        }),
      );
    } on DioException catch (e) {
      // The interesting refusals arrive as a body, not an exception: 413 for a file over
      // the limit, 400 for a binary posing as text or an image a proven text-only model
      // cannot see. Surface the server's sentence — it names the file and says why.
      final data = e.response?.data;
      if (data is Map) {
        throw NelleApiException.fromResponse(
          Response<Map<String, dynamic>>(
            requestOptions: e.requestOptions,
            statusCode: e.response?.statusCode,
            data: data.cast<String, dynamic>(),
          ),
        );
      }
      throw NelleApiException.network(e);
    }
    final code = res.statusCode ?? 0;
    if (code < 200 || code >= 300) {
      throw NelleApiException.fromResponse(res);
    }
    final data = res.data;
    if (data == null) {
      throw NelleApiException('The upload returned no body.', statusCode: code);
    }
    return UploadResponse.fromJson(data);
  }
}

final uploadRepositoryProvider = Provider<UploadRepository>(
  (ref) => UploadRepository(ref.watch(dioProvider)),
);
