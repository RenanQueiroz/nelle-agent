import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';

/// The server's `display` preferences (`GET /api/settings/display`) — the rendering toggles
/// that follow the user to every device.
///
/// This is the **first** consumer of the display group in the client: the settings screen
/// writes these, but nothing read them for rendering until per-message stats needed
/// `showGenerationStats`. Read the whole group so a later toggle is one getter away, not a
/// second request.
///
/// A default here is a claim the client makes before the server answers, so it must match what
/// the server would say — every display default is `true` except the two markdown/scroll ones,
/// and `showGenerationStats` in particular defaults on (the stats are a feature, not an
/// opt-in). Being briefly wrong the other way would blink the stats off on a slow first load.
class DisplaySettings {
  const DisplaySettings({this.showGenerationStats = true});

  final bool showGenerationStats;

  static DisplaySettings fromJson(Map<String, dynamic> json) => DisplaySettings(
    showGenerationStats: json['showGenerationStats'] as bool? ?? true,
  );
}

/// Never throws: a failed settings read must not blank the transcript. It falls back to the
/// server defaults, which is the inert, feature-on state.
final displaySettingsProvider = FutureProvider<DisplaySettings>((ref) async {
  final dio = ref.watch(dioProvider);
  try {
    final res = await dio.get<Map<String, dynamic>>('/api/settings/display');
    final code = res.statusCode ?? 0;
    final data = res.data;
    // A non-2xx does not throw (dio hands back the body for NelleError reading), so check the
    // status before trusting the payload — an error body parsed as settings is silent nonsense.
    if (code < 200 || code >= 300 || data == null) {
      return const DisplaySettings();
    }
    return DisplaySettings.fromJson(data);
  } on DioException {
    return const DisplaySettings();
  }
});
