import 'helpers/device_harness.dart';
import 'suites/errors.dart';
import 'suites/http_probe.dart';
import 'suites/lifecycle.dart';
import 'suites/smoke.dart';

/// **The one entrypoint**, and it is not a stylistic choice.
///
/// `flutter test` given a *directory* of `integration_test` files runs each in turn — and on the
/// Linux desktop the second one cannot relaunch the app ("Unable to start the app on the device /
/// The log reader stopped unexpectedly"). The previous instance has not let go. It is also
/// wasteful: every file pays a full app launch, and a launch here is ~40 seconds.
///
/// So the suites are **functions, not `main()`s**. One process, one binding, one launch, and each
/// `testWidgets` pumps a fresh tree inside it. Each suite file is still readable on its own, and
/// `flutter test integration_test/app_test.dart --plain-name '...'` still runs one test.
void main() {
  // Must come first: the binding has to exist before any `testWidgets` is registered.
  initDeviceBinding();

  // The assumption everything else rests on: a device test can reach a real server. If this fails,
  // nothing below it means anything.
  httpProbeSuite();

  smokeSuite();
  lifecycleSuite();
  errorsSuite();
}
