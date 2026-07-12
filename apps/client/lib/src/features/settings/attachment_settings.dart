import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// The server's attachment settings (`GET /api/settings/attachments`).
///
/// **The client carries no copy of the defaults.** A threshold the user changed in
/// Settings is the server's answer, not a constant compiled into an app that may be
/// months old — so until this resolves there is *no* threshold, and every paste stays in
/// the message. That is the safe direction to be wrong in: the alternative is a stale
/// default silently turning someone's paste into a file attachment.
class AttachmentSettings {
  const AttachmentSettings({
    this.pasteToFileCharacters,
    this.maxImageMegapixels,
  });

  /// A paste longer than this becomes a `.txt` upload. `0` disables it, and `null`
  /// means the server has not answered yet — which is *not* the same as `0`, but
  /// behaves the same way, on purpose.
  final int? pasteToFileCharacters;

  /// Images above this are downscaled — **server-side, at upload**. The client only
  /// reads it to say so; it never resizes anything itself.
  final double? maxImageMegapixels;

  /// Whether a paste of [length] characters should become a file.
  bool shouldPasteToFile(int length) {
    final threshold = pasteToFileCharacters;
    // Unknown (not answered) and 0 (disabled) both mean "leave it in the message".
    if (threshold == null || threshold <= 0) {
      return false;
    }
    return length > threshold;
  }

  static AttachmentSettings fromJson(Map<String, dynamic> json) =>
      AttachmentSettings(
        pasteToFileCharacters: (json['pasteToFileCharacters'] as num?)?.toInt(),
        maxImageMegapixels: (json['maxImageMegapixels'] as num?)?.toDouble(),
      );
}

/// Never throws: a settings read that fails must not stop anyone from typing. It simply
/// leaves every threshold unknown, which is the inert state.
final attachmentSettingsProvider = FutureProvider<AttachmentSettings>((
  ref,
) async {
  final dio = ref.watch(dioProvider);
  try {
    final res = await dio.get<Map<String, dynamic>>(
      '/api/settings/attachments',
    );
    final code = res.statusCode ?? 0;
    final data = res.data;
    // A non-2xx does not throw: dio hands back the body so a NelleError can be read off
    // it. Parsing an error body as settings would silently yield nonsense.
    if (code < 200 || code >= 300 || data == null) {
      return const AttachmentSettings();
    }
    return AttachmentSettings.fromJson(data);
  } on DioException {
    return const AttachmentSettings();
  }
});
