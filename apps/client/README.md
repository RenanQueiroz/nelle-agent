# nelle_agent

Flutter client (desktop + mobile) for the Nelle Agent server. Replaces the React
web app (`apps/web`) with one Dart codebase. Talks to the server only over its
served REST + SSE contract.

## Stack

- **forui** components over `MaterialApp` (Material widgets as the fallback).
- **Riverpod** for state, **dio** for HTTP + SSE, **go_router** for routing.
- **Contract-first models**: Dart DTOs are codegen'd from the server's OpenAPI
  (`../../openapi.json`) into `lib/src/api/generated/`. The streaming union
  (`ChatStreamEvent`) is hand-written, not codegen'd.

## Run (dev)

Needs the server up (`bun run dev:server` from repo root, with a model loaded) and
Flutter 3.44+. Loopback, no auth in M1.

```bash
flutter run -d linux     # or -d chrome / -d <android device>
```

**GPU rendering under WSL.** By default the Linux desktop build renders in software
(`llvmpipe`) — fine for dev, and the window still shows. To render on a discrete GPU
instead, the app must run on **Wayland** (not the X11/XWayland fallback, whose EGL can't
reach the WSLg GPU) and be pointed at the right adapter:

```bash
XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir \
GALLIUM_DRIVER=d3d12 \
MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA \
flutter run -d linux
```

- `XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir` points at where WSLg's Wayland socket actually
  is (the systemd default `/run/user/1000` often doesn't exist under WSL), so the app runs
  on Wayland and its EGL context can reach the GPU. This also silences the `dconf` warnings.
- `GALLIUM_DRIVER=d3d12` selects the GPU's D3D12 driver over `llvmpipe`.
- `MESA_D3D12_DEFAULT_ADAPTER_NAME` picks a GPU by case-insensitive substring — set it to
  your discrete GPU's name (Mesa otherwise defaults to the integrated one). See the
  [WSLg GPU-selection notes](https://github.com/microsoft/wslg/wiki/GPU-selection-in-WSLg).

Confirm with `nvidia-smi` (the `nelle_agent` process appears with a `G`/graphics context),
or the frame-timing overlay below. Note this is compute-independent: llama.cpp already uses
the GPU for inference regardless of any of this.

**Frame-timing overlay.** Add `--dart-define=nelle.perfOverlay=true` to any `flutter run`
to draw Flutter's UI + raster thread graphs. It reads `0.0 ms/frame` at idle — Flutter only
repaints on change — so scroll a long list or drive an animation to compare software vs GPU.

## Regenerate API models (after the server contract changes)

Rebuild `../../openapi.json` first (`bun run build:openapi` at repo root), then:

```bash
dart run tool/gen_api.dart                              # strip paths -> openapi.models.json (models only)
dart run swagger_parser                                 # openapi.models.json -> lib/src/api/generated/*.dart
dart run build_runner build --delete-conflicting-outputs # *.g.dart (json_serializable)
```

The generated files are committed so the app builds without running codegen.
`openapi.models.json` is an intermediate and is git-ignored.

## Agent-driven UI testing (MCP)

The app is instrumented so an AI agent can drive the UI and see it — the Flutter
equivalent of Playwright MCP. Both servers are registered per project, in the repo:
`.mcp.json` (Claude Code) and `.codex/config.toml` (Codex, which does not read
`.mcp.json`) — keep the two in sync.

- **`marionette_mcp`** — `get_interactive_elements` (widget inspection), `tap`,
  `double_tap`, `long_press`, `enter_text`, `swipe`, `scroll_to`,
  `press_back_button`, `take_screenshots`, `get_logs`, `hot_reload`.
- **`dart mcp-server`** (official Dart/Flutter) — runtime errors, widget tree, hot
  reload, run tests, analyze, pub.dev search.

One-time local prerequisites:

```bash
dart pub global activate marionette_mcp   # installs the marionette_mcp executable
# ~/.pub-cache/bin and the Flutter SDK bin must be on PATH
```

`lib/main.dart` initializes `MarionetteBinding` **only under `kDebugMode`**; release
builds keep the plain `WidgetsFlutterBinding`, so the instrumentation never reaches a
shipped app. Workflow: run the app in debug (`flutter run -d linux`), and the agent
attaches to its Dart VM Service to drive it. **Restart the agent session after
changing `.mcp.json`** — MCP servers load at session start.

## Checks

```bash
flutter analyze
flutter test
```
