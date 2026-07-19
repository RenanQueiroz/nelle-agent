import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }

  /// Take focus on launch.
  ///
  /// An app started from a terminal — which is every `bun run dev` — can come up *inactive*:
  /// its window is on screen and draggable (the window server moves windows out of process),
  /// but it is not the active application, so clicks land on activation rather than on the UI
  /// and the frame shows no resize cursor. It reads exactly like a freeze, and it clears the
  /// moment something activates the app, which is why it "starts working like nothing
  /// happened". `flutter run` tries to do this itself and reports `Failed to foreground app;
  /// open returned 1` when it cannot.
  ///
  /// Activating here is what a user launching an app expects in any case; the terminal case is
  /// simply the one where nothing else does it.
  override func applicationDidFinishLaunching(_ notification: Notification) {
    super.applicationDidFinishLaunching(notification)
    NSApp.activate(ignoringOtherApps: true)
  }
}
