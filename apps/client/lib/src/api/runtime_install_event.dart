import 'generated/models/nelle_error.dart';
import 'generated/models/runtime_status.dart';

/// The narration of a llama.cpp install (`POST /api/runtime/install/stream`).
///
/// Installing is a **build**, not a request: on Linux it is a `git clone` plus a full cmake
/// compile — minutes, sometimes tens of them. So the server streams it, and streams the
/// build's own output with it.
///
/// Hand-written rather than codegen'd, like [ChatStreamEvent] and `SettingsField`. The four
/// variants do carry distinguishable keys, so swagger_parser's try-each-variant deserializer
/// might even stumble into the right answer — but "might" is the problem. The wire `type` is
/// the contract, a sealed switch on it is exhaustive, and an unrecognised variant becomes
/// [UnknownInstallEvent] rather than an exception thrown in the middle of a ten-minute build.
sealed class RuntimeInstallEvent {
  const RuntimeInstallEvent();

  /// Reads the Nelle SSE envelope (`{type, data: <event>}`), tolerating a raw event.
  factory RuntimeInstallEvent.fromEnvelope(Map<String, dynamic> json) {
    final data = json['data'];
    final event = data is Map<String, dynamic> ? data : json;
    final type = (event['type'] ?? json['type']) as String? ?? '';

    return switch (type) {
      'runtime.install.started' => InstallStartedEvent(
        mode: event['mode'] as String? ?? '',
      ),
      'runtime.install.output' => InstallOutputEvent(
        line: event['line'] as String? ?? '',
        isStderr: event['stream'] == 'stderr',
      ),
      'runtime.install.completed' => InstallCompletedEvent(
        runtime: RuntimeStatus.fromJson(
          (event['runtime'] as Map).cast<String, Object?>(),
        ),
      ),
      'runtime.install.failed' => InstallFailedEvent(
        error: NelleError.fromJson(
          (event['error'] as Map).cast<String, Object?>(),
        ),
      ),
      _ => UnknownInstallEvent(type),
    };
  }
}

/// `mode` is `external` when `LLAMA_SERVER_PATH` is set: nothing is built, the status is
/// simply reported, and the stream ends almost at once.
class InstallStartedEvent extends RuntimeInstallEvent {
  const InstallStartedEvent({required this.mode});
  final String mode;
}

/// One line of the build's own output.
///
/// **[isStderr] does not mean failure.** cmake and git narrate their progress there — a real
/// llama.cpp build emitted 820 stdout lines, 2 stderr, and succeeded. A client that paints
/// stderr red calls a working build broken. (The same trap lives in llama-server's log, where
/// a *successful* offline load of a pinned model writes an `E` line.)
///
/// Order is guaranteed **within** a stream and never **between** the two: the server drains
/// both pipes concurrently, and even in a terminal stdout is block-buffered to a pipe while
/// stderr is unbuffered, so faithful interleaving does not exist anywhere. Render two ordered
/// streams; never claim a global order.
class InstallOutputEvent extends RuntimeInstallEvent {
  const InstallOutputEvent({required this.line, required this.isStderr});
  final String line;
  final bool isStderr;
}

/// The build finished. Carries the authoritative status, so nothing needs refetching.
class InstallCompletedEvent extends RuntimeInstallEvent {
  const InstallCompletedEvent({required this.runtime});
  final RuntimeStatus runtime;
}

/// The build stopped, and why. The output is **not** repeated here — it has already been
/// streamed, line by line, and a client that kept it has the whole story.
class InstallFailedEvent extends RuntimeInstallEvent {
  const InstallFailedEvent({required this.error});
  final NelleError error;
}

/// A newer server invented an event this build has never heard of. Ignoring it is always
/// safe; crashing ten minutes into a build is not.
class UnknownInstallEvent extends RuntimeInstallEvent {
  const UnknownInstallEvent(this.type);
  final String type;
}
