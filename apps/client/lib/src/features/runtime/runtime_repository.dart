import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/generated/models/llama_router_props.dart';
import '../../api/generated/models/runtime_log_tail.dart';
import '../../api/generated/models/runtime_status.dart';
import '../../api/request.dart';
import '../../api/runtime_install_event.dart';
import '../chat/sse_transport.dart';

/// The llama.cpp runtime: what is installed, whether it is running, and its log.
class RuntimeRepository {
  RuntimeRepository(this._dio, this._sse);

  final Dio _dio;
  final SseTransport _sse;

  /// [checkLatest] costs a GitHub round trip, so it is opt-in — which is why `apps/web`,
  /// having never passed it, could never show whether an update was available.
  Future<RuntimeStatus> status({bool checkLatest = false}) async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>(
        '/api/runtime',
        queryParameters: checkLatest ? const {'latest': '1'} : null,
        options: longCall(),
      ),
    );
    return RuntimeStatus.fromJson(res.data ?? const {});
  }

  /// The router's own view — `maxInstances` is `--models-max`, and it is where the
  /// "3/4 loaded" capacity line comes from. 502s when llama.cpp is stopped, which is a
  /// state and not a crash.
  Future<LlamaRouterProps> props() async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>('/api/llama/props'),
    );
    return LlamaRouterProps.fromJson(res.data ?? const {});
  }

  /// Starts llama.cpp. The **server** waits up to 30 s for its health probe — a coin flip
  /// against dio's 30 s default, to the millisecond — so this is one of the calls that needs
  /// its own timeout.
  Future<RuntimeStatus> start() async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/runtime/start',
        options: longCall(),
      ),
    );
    return RuntimeStatus.fromJson(res.data ?? const {});
  }

  Future<RuntimeStatus> stop() async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/runtime/stop',
        options: longCall(),
      ),
    );
    return RuntimeStatus.fromJson(res.data ?? const {});
  }

  /// Deletes the installed binary and, on Linux, the cloned source. The server stops llama.cpp
  /// first, keeps `models.ini` and the downloaded weights, and refuses
  /// (`runtime_not_uninstallable`) when the binary is the user's own `LLAMA_SERVER_PATH`.
  Future<RuntimeStatus> uninstall() async {
    final res = await sendJson(
      () => _dio.post<Map<String, dynamic>>(
        '/api/runtime/uninstall',
        options: longCall(),
      ),
    );
    return RuntimeStatus.fromJson(res.data ?? const {});
  }

  /// A one-shot tail. There is no log *stream*, so a client that wants live output polls
  /// this — which is why the screen you open to find out why llama-server just died is the
  /// one screen that cannot show you it dying, unless it polls.
  Future<RuntimeLogTail> logs({int maxBytes = 80000}) async {
    final res = await sendJson(
      () => _dio.get<Map<String, dynamic>>(
        '/api/runtime/logs',
        queryParameters: {'maxBytes': '$maxBytes'},
      ),
    );
    return RuntimeLogTail.fromJson(res.data ?? const {});
  }

  /// Installs or updates llama.cpp, narrating the build as it goes.
  ///
  /// Never the non-streaming `POST /api/runtime/install`: on Linux that is a `git clone` plus
  /// a full cmake compile, and awaiting it would show the user a silent spinner for minutes
  /// and then time out — reporting failure for a build that was succeeding. That is precisely
  /// the bug this stream exists to fix, so do not "simplify" it back.
  /// [version] installs a specific upstream version instead of the latest — a release tag
  /// (or, on a Linux server, a git sha). It exists so reverting to
  /// `RuntimeStatus.previousVersion` is one request: llama.cpp floats to latest by design,
  /// and a bad upstream day is undone by stepping back, never by pinning.
  Stream<RuntimeInstallEvent> install({
    CancelToken? cancelToken,
    String? version,
  }) {
    return _sse
        .streamJson(
          '/api/runtime/install/stream',
          method: 'POST',
          body: version == null ? null : {'version': version},
          cancelToken: cancelToken,
        )
        .map(RuntimeInstallEvent.fromEnvelope);
  }
}

final runtimeRepositoryProvider = Provider<RuntimeRepository>(
  (ref) => RuntimeRepository(
    ref.watch(dioProvider),
    ref.watch(sseTransportProvider),
  ),
);
