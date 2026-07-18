---
name: driving-the-client
description: Drive the running Nelle Flutter app with the Marionette MCP server to verify UI changes end to end — required before any client change counts as done. Use when running, driving, screenshotting, or interactively debugging the client app, when driving it on the Android emulator, or when image paste, the keyring, or phone networking behaves oddly under Linux or WSL2.
---

# Driving the running client

The Flutter client is instrumented for agent-driven UI testing: run the app in
debug and attach to its Dart VM Service with the `marionette` MCP server.
Prerequisite: `dart pub global activate marionette_mcp`, with `~/.pub-cache/bin`
and the Flutter SDK bin on PATH. `lib/main.dart` initializes `MarionetteBinding`
only under `kDebugMode`, so release builds carry no instrumentation.

## Workflow

For every UI-affecting change:

1. Run the app in debug (`bun run dev:client`, or `flutter run -d <target>`).
2. `connect`, then `get_interactive_elements` to discover what is on screen.
3. Drive the real flow: `tap`, `enter_text`, `scroll_to`, `swipe`.
4. `take_screenshots` **and look at them** — assert on what is on screen, not on
   what you believe you built. Never ask the user to eyeball a screen you could
   have driven yourself.
5. Check `get_logs` and the `dart` MCP server's `get_runtime_errors` for
   exceptions and overflows.
6. Any bug found this way gets a regression device test before the fix is
   committed (see the `device-tests` skill).

Marionette matches by `ValueKey` or visible text — give every interactive widget
a stable `ValueKey`, because tapping raw coordinates silently rots.

## Drive the edges

That is where client bugs live and where no unit test looks: empty states, error
states (`llama_server_stopped`, `model_load_failed`, `context_overflow`), a
refusal before `run.started`, mid-stream abort, degenerate content, the
narrow/wide layout break, switching conversations mid-run, and an unknown event
type.

For any model-backed drive, use the small models — see the `model-testing`
skill.

## Platform quirks (Linux / WSL2)

These apply only when the development machine is Linux — and the WSL2/WSLg ones
only under WSL. On macOS and Windows this section does not apply.

- **A physical phone on the LAN cannot reach a WSL2 dev machine.** WSL2 is NAT'd
  by default, so Nelle binds the VM's `172.31.x.x` while the phone is on the
  host's `192.168.x.x` — the two do not meet without `networkingMode=mirrored`
  in `.wslconfig` or a Windows `netsh portproxy`. **An Android emulator needs
  neither**, because it runs _inside_ WSL and shares its network namespace: it
  dials `https://172.31.x.x:8788` directly. That makes the emulator the way to
  drive the phone, and a second desktop instance pointed at the TLS listener the
  way to drive a remote client. Neither is a bug to fix — they are the shape of
  the machine.
- **Driving the Android emulator under WSL needs two non-obvious flags.** It aborts
  with `Unable to create /run/user/1000/avd/running` because WSL has no
  `XDG_RUNTIME_DIR`, and it hangs at 0.1% CPU forever waiting on a WSLg window —
  so give it a writable `XDG_RUNTIME_DIR` and run it **`-no-window`**. Headless
  costs nothing: Marionette attaches to the Dart VM over adb and screenshots
  come from Flutter, not from the emulator's window.
  `emulator -avd <name> -no-window -gpu swiftshader_indirect -no-snapshot`, then
  `flutter run -d emulator-5554`. KVM needs the user in the `kvm` group; without
  it the boot silently falls back to something unusable.
- **WSLg cannot carry an image on the clipboard between processes**, so image
  paste cannot be driven end-to-end under WSLg: the bridge takes the
  CLIPBOARD selection and only preserves text, and a GTK image set by any other
  process (verified with PyGObject, and with the image set on the Windows side)
  vanishes. _File_ paste is drivable and was driven (a real Ctrl+V of a copied
  file produced its chip), and the bytes-to-chip path below it is the same one
  the file picker uses. Do not read a failing image-paste drive here as a code
  fault without first checking `wait_for_targets()`.
- **A drive must never share the developer's keyring.** gnome-keyring pops a GUI
  dialog whenever a collection must be _created or unlocked_, which blocks an
  unattended drive exactly as it blocks a human. Give the drive a throwaway
  keyring where neither is ever true — an isolated `XDG_DATA_HOME`, the
  `default` alias pre-seeded to `login`, and an empty-password login keyring
  unlocked on stdin: `printf 'login' > "$XDG_DATA_HOME/keyrings/default"` then
  `dbus-run-session -- sh -c 'printf "\n" | gnome-keyring-daemon --unlock --components=secrets; flutter run -d linux'`.
  A real Linux user still sees their OS keyring prompt on first pair, once; that
  is their desktop asking, and it is correct.
