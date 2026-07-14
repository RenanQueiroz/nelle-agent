# Nelle Agent

Local-first AI agent you run on your own hardware. Nelle Agent is a monorepo — a
Bun **API server** that manages a local `llama.cpp` runtime and runs the Pi agent
harness, plus the **Flutter client** that connects to it — meant to ship as a
single cross-platform installer.

`apps/server` runs on Bun with `bun:sqlite` and `Bun.serve`, and shared contracts
live in `packages/shared`. It serves REST + typed SSE and nothing else: no web app,
no static files, no SPA fallback — an unmatched path is a coded JSON 404. The whole
surface is published at `GET /api/openapi.json`.

`apps/client` is the Dart/Flutter desktop + mobile client, and the only client.
It speaks the served contract and never imports server TypeScript.

Server and client both run on Windows, macOS, and Linux; the client also builds for
Android and iOS.

## Current MVP

Implemented, server side:

- `Bun.serve` API server over a small native router: REST for conversations,
  models, settings, uploads and runtime control; SSE for chat runs, llama.cpp
  router events and llama.cpp installs.
- A loopback listener (`127.0.0.1:8787`, trusted — arriving there is proof of local
  access) and an opt-in TLS LAN listener (`0.0.0.0:8788`) where every request needs a
  device bearer token. Pairing hands the device a code/QR carrying the self-signed
  certificate's SHA-256 fingerprint, which the client **pins**; tokens rotate on
  refresh.
- Managed `llama.cpp` runtime control:
  - Linux installs/updates by building latest `ggml-org/llama.cpp` master;
    Windows/macOS download the latest GitHub release assets. The build is
    **streamed** (`POST /api/runtime/install/stream`), line by line, because it takes
    minutes and a silent spinner is not a progress report.
  - Runtime start/stop uses router mode with `--models-preset`, and configurable
    `--models-max` / `--sleep-idle-seconds` (the `runtime` settings group).
  - The router pid is persisted under `.nelle/llama/` so a restarted server can adopt
    and stop the llama-server it previously started.
- Hugging Face GGUF search and quant selection; the model is written to `models.ini`
  as an `hf-repo` entry and `llama-server` downloads and caches the weights under
  `.nelle/models/` (Nelle's own Hugging Face cache root, not the user's global one).
  A model that has loaded once is **pinned** to its downloaded weights, so an
  upstream re-upload cannot break it.
- A lossless `models.ini` parser/writer that preserves comments, ordering and unknown
  keys. `models.ini` is the model catalog and the source of truth for free-form
  llama.cpp params, validated against the binary's own `--help` catalogue rather than
  a list Nelle carries.
- Nelle writes no context size — it writes a _floor_ (`fitc = 32768`) and lets
  llama.cpp's `--fit` pick the window, then reports what a conversation actually got
  from `/props`.
- SQLite schema/migrations in `.nelle/settings.sqlite`, with timestamped backups under
  `.nelle/backups/`. Each conversation is bound to a Nelle-owned **Pi session JSONL**
  under `.nelle/pi/sessions`, which is authoritative for history, compaction and
  branches; SQLite holds the projection of the active branch and Nelle-only sidecar
  metadata. A missing or malformed session file marks the conversation `unavailable`
  and surfaces `session_unavailable` — never a silently empty chat — with explicit
  repair / rebuild / diagnostics endpoints.
- Conversation-scoped chat and regenerate streaming
  (`/api/conversations/:id/chat/stream`), serialized as Nelle SSE envelopes with
  monotonic event ids, stable run ids, `run.started` / `run.completed` terminal
  events, and stream `error` events carrying stable `NelleError` codes.
- The **server** loads the model a run needs (`ensureModelRunnable`), streaming
  `model.loading` progress while it waits, so a client never has to poll.
- Reasoning support for thinking models: a per-conversation level (`off`, `low`,
  `medium`, `high`, `max`, defaulting to `max`) driving Pi's thinking level, with
  thinking streamed separately from the answer as `message.assistant.reasoning_delta`
  and persisted with the conversation. Per-level token budgets are a settings group
  (llama.cpp's own 512 / 2048 / 8192 defaults), applied as `thinking_budget_tokens`.
- Pi SDK chat harness pointed at Nelle's own `/api/llama-proxy/v1` provider, so
  streamed `prompt_progress` and `timings` chunks become `performance.updated` events
  and an abort closes the upstream llama.cpp fetch. A direct llama.cpp
  chat-completions fallback runs if Pi initialization fails.
- Attachments are **uploaded, not embedded**: bytes go to `POST /api/uploads`
  (multipart), which classifies the file, refuses a binary posing as text, extracts PDF
  text, and answers an `uploadId`. A PDF with a text layer is sent as text on any
  model; a scan has no text to send, so the server renders its pages as images, which
  needs a vision model. There is no rendering switch — only the server knows both the
  document and the model. A message whose images would leave Pi no room to reply is
  refused before the run, naming the context size that would fit.
- Conversation fork (branch at a user message), clone, export and import as local
  `.nelle-chat.zip` archives (manifest, checksums, the Pi session JSONL, sidecar
  metadata, referenced attachments, model snapshots, and `tool-audit.jsonl` when host
  tools ran). Imports always create a new conversation.
- Host file/shell tools, disabled until the user acknowledges that they are
  unsandboxed. They fail closed at runtime, not only at session construction, and every
  execution is persisted as an audit row.
- Settings are declared once in `SETTINGS_REGISTRY` and **served** as a schema
  (`GET /api/settings/schema`), so a client renders a new setting without a release.
- After the first exchange in a fallback-titled conversation, Nelle asks llama.cpp for
  a concise title through the local proxy, without persisting that prompt in Pi history.
- Startup sweeps: orphan files under `.nelle/attachments/` no longer referenced by
  SQLite, and unbound uploads older than 24h under `.nelle/uploads/` (hourly
  thereafter).

Implemented, client side (`apps/client`):

- Riverpod + `dio` + `go_router` + forui, with contract-first codegen of the API DTOs
  from `openapi.json`. Chat with streamed deltas, reasoning blocks, markdown (with
  LaTeX and syntax-highlighted code), model selection and reasoning level per
  conversation, model load progress in the transcript, attachments with drag-and-drop
  and paste, `/compact`, abort, regenerate with variants.
- The full conversation lifecycle: search, pin, rename, fork, clone, export, import,
  repair, rebuild, diagnostics, and a held (undoable) delete.
- Settings rendered generically from the served schema, plus the model catalog, the
  parameter editor, Hugging Face import, and llama.cpp install/start/stop with the
  build's own output streamed into the UI.
- LAN pairing: paste or scan the code/QR, pin the certificate, store the token in the
  OS keyring.

Not implemented yet:

- Push notifications.
- Packaging and a launcher. There is no `bin` entrypoint or installer; `bun run serve`
  runs the server.
- A first-run setup wizard. Runtime install, model import, and parameter editing all
  live in Settings rather than a guided onboarding flow.
- Full Pi branch tree explorer. The client shows the active path, regenerate variants,
  clone and fork, while inactive branches stay preserved in the Pi session files.
- Host-tool sandboxing and per-tool permission prompts. The current gate is
  acknowledgement plus a global enable/disable switch.
- Full SQLite app-state persistence. Nelle still uses `.nelle/state.json` for the
  llama.cpp address, the catalog backup, and direct-fallback compatibility.

## Roadmap

- **Single cross-platform installer.** Ship the Bun server (`bun run build:binary`, per
  platform) and the client as one executable. The Linux-x64 binary is validated — it
  builds, boots, serves, and renders PDF pages via `@napi-rs/canvas` inside the compiled
  binary; macOS-arm64 and Windows-x64 still need a CI matrix and an on-target pass
  (including the llama-server process lifecycle).
- **First-run setup wizard**, host-tool sandboxing, and a full Pi branch-tree explorer
  (see "Not implemented yet" above).

## Setup

Use Bun 1.3+. The server, tests, and toolchain all run on Bun — there is no npm/Node
runtime dependency.

```bash
bun --version
bun install
```

## Run

```bash
bun run dev     # bun --watch, restarts on change
bun run serve   # a single process; use this when you need to stop it deterministically
```

The API server listens on `127.0.0.1:8787`. It serves no UI — run `apps/client` against
it (below), or drive it with `curl`.

Set these environment variables when needed:

- `NELLE_DATA_DIR`: override the default `.nelle/` app data directory.
- `NELLE_PORT`: change the local API port.
- `NELLE_HOST`: change the bind host.
- `NELLE_TLS_PORT`: change the LAN (TLS) listener port.
- `LLAMA_SERVER_PATH`: use an existing `llama-server` binary instead of the managed
  install.
- `NELLE_LLAMA_PORT`: the port Nelle expects llama-server on (default `8080`). Pin it
  in any harness, or the runtime probe adopts a llama-server it did not start.
- `NELLE_PI_DISABLED=1`: bypass Pi and use direct llama.cpp chat completions.

Smoke probes after starting the server:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/conversations
curl -fsS 'http://127.0.0.1:8787/api/huggingface/search?q=tiny%20gguf'
```

## Flutter client (`apps/client`)

`apps/client` is the Dart/Flutter client (package `nelle_agent`, bundle id
`com.renanqueiroz.nelle_agent`) — the desktop + mobile UI. It talks to the server only
over the served REST + SSE contract (`GET /api/openapi.json`) and never reaches into
server internals, so it is insulated from the Bun toolchain: Oxfmt, Oxlint, and `tsc`
all ignore `apps/client`, and its `build/` and `.dart_tool/` artifacts are git-ignored.

The Flutter SDK is a native install kept outside the repo — not committed, and not a
Homebrew package (Homebrew's `flutter` is a macOS-only cask). Install it per the
[manual instructions](https://docs.flutter.dev/install/manual); this repo is developed
against Flutter 3.44 (Dart 3.12). Confirm the toolchain with `flutter doctor`.

Per-platform toolchains (install only what you build for):

- **Web** — needs Chrome, nothing else. (LAN pairing is native-only: a browser decides
  about a certificate before any Dart runs, so it cannot pin.)
- **Linux desktop** — `sudo apt install clang ninja-build libgtk-3-dev`
  (`mesa-utils` for GPU info).
- **Android** — the Android SDK command-line tools (`sdkmanager`) with `platform-tools`,
  `platforms;android-36`, and `build-tools;36.0.0`, licenses accepted, plus
  `ANDROID_HOME` exported. A JDK 17+ is required (JDK 21 works).
- **iOS / macOS** — build on a Mac with Xcode.

Run and build:

```bash
cd apps/client
flutter run -d linux       # Linux desktop
flutter run -d chrome      # web
flutter build apk          # Android
```

## llama.cpp Flow

1. Search Hugging Face and choose a GGUF quant.
2. Install `llama.cpp` from Settings. On Linux this builds latest upstream master and
   may require `git`, `cmake`, `make`, `gcc`, `g++`, OpenSSL headers, and optionally
   CUDA tooling; it takes minutes, which is why it is user-triggered and streamed.
3. Optionally adjust max loaded models or idle sleep seconds. These launch settings
   require a `llama.cpp` restart to take effect.
4. Start the runtime: `llama-server` launches with the generated `.nelle/llama/models.ini`.
5. Chat. The server loads the conversation's model when the run starts, so submitting a
   prompt shows it in the transcript immediately, followed by a `Loading weights NN%`
   placeholder — a cold start is visible where the conversation is, not only in the
   model picker.
6. Use `New chat` to create a separate Pi-backed conversation; a conversation's action
   menu renames, pins, forks, clones, exports or deletes it.

Nelle writes **no** context size into a preset. It writes a floor for llama.cpp's
auto-fit (`fitc = 32768`, `PI_MINIMUM_CONTEXT_TOKENS`) and lets llama.cpp choose the
window, then reads back what the model actually got from `/props`. The floor is
measured, not guessed: Pi's agent system prompt plus its 4,096-token reply reserve do
not fit in 16,384 tokens, and a conversation that does not fit clamps `max_tokens` to 1
— every reply stops after one token, while looking like it worked. Nelle warns in the
composer when a prompt leaves no usable reply budget.

For Hugging Face selections, Nelle stores the repo/quant reference and writes an
`hf-repo` entry into `models.ini`, for example:

```ini
[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

The `hf-repo` line uses the same model selection as launching `llama-server` with:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

`llama.cpp` handles the download and the cache — into `.nelle/models/`, which Nelle
hands it as `LLAMA_CACHE` (unless the user has set a cache location of their own). Nelle
does not register local GGUF filesystem paths; model selection is Hugging Face
`hf-repo` only. Nelle keeps the exact Hugging Face ref for `hf-repo`, but canonicalizes
the router section and OpenAI `model` id the same way llama.cpp does — `UD-Q4_K_XL` is
exposed by llama.cpp as `Q4_K_XL`.

Every model is registered with Pi's `qwen-chat-template` compatibility, which is Pi's
name for sending `chat_template_kwargs.enable_thinking`. Whether the reasoning control
is offered for a model is decided from the chat template llama.cpp reports on `/props`,
not from the model's name.

Generated presets do not set `n-gpu-layers` by default; llama.cpp uses its own default
unless GPU offload is explicitly configured. If free-form model parameters make
llama-server fail to start, the runtime log tail (`GET /api/runtime/logs`, and the log
screen in Settings) carries llama.cpp's own reason.

Nelle writes `.nelle/llama/llama-server.pid.json` when it starts the router. On restart,
Nelle validates that pid against the managed `models.ini` command line before treating
the runtime as controllable. If the configured port already has a healthy llama.cpp
server but no managed pid, Nelle reports it as running and does not start another
process.

## Getting set up

```bash
bun run setup      # bun install, flutter pub get, marionette_mcp, arm the pre-push hook
bun run doctor     # what this machine has, what it is missing, and the command to fix it
```

`setup` installs only what this repository owns. It deliberately does **not** install Bun, the
Flutter SDK, the JDK, the Android SDK, Xcode, or a keyring — those need `sudo`, have no single
correct install method, are not idempotent if you already have one somewhere else, and in Xcode's
and the Android licences' case need interactive consent a script cannot honestly give. (Also,
`setup` runs under Bun, so it could never install Bun.)

`doctor` does the hard half instead: it knows what is needed, at what version, and prints the exact
command **for your OS**. It marks each item required or optional _relative to what you can actually
do on this machine_ — you are not failed for lacking the Android SDK if you are only touching the
server — and it finishes by telling you which targets this host can build and device-test.

`setup` also arms a **pre-push hook** (`bun run hooks on|off|status` to toggle). It scopes itself to
what changed: server files run the server gate, `apps/client/**` runs the Flutter gate, a
build-config change also builds, and a docs-only push skips entirely.

## Checks

```bash
bun run format:check
bun run lint
bun run check       # tsc, over apps/ packages/ scripts/ AND tests/
bun run test:unit
bun run test        # the composite: format check, lint, tsc, unit tests
```

Formatting and linting use Oxfmt and Oxlint with repo-local config files:
`.oxfmtrc.json` and `.oxlintrc.json`.

Useful Oxc commands:

```bash
bun run format
bun run lint:fix
```

The client has its own checks — `flutter analyze` and `flutter test`, run from
`apps/client` — plus the device suite below.

### The Flutter client's device tests

```bash
bun run test:device                      # the fast tier, with llama.cpp stopped
bun run test:device:slow                 # a real gemma-4-E2B, really generating
bun run test:device -- -d emulator-5554  # the same fast tier, on a phone
```

These run the **real** client — `main()`, real providers, real dio, real HTTP — against a
**real Nelle server**: `scripts/serve-fixture.ts`, on a throwaway `.nelle-device/`, port 8797. They are the regression tier, pinning behaviour that driving the app with
Marionette discovered; Marionette stays the exploratory tool.

The fast tier keeps llama.cpp stopped, which is what a fresh install looks like and where
most error paths live. The slow tier loads a small model and asks it real questions, because
a chat app whose chatting is never tested end to end has a hole in the middle of it. It is
separate because it costs minutes, and a suite nobody runs because it is slow is worse than
one that is honestly optional.

Run the fast tier on the emulator too — the phone finds what the desktop hides. Boot it
headless first (`-no-window` and a writable `XDG_RUNTIME_DIR` are both required under WSL):

```bash
emulator -avd nelle_phone -no-window -gpu swiftshader_indirect -no-snapshot
```

The harness runs `adb reverse` itself, so the emulator reaches the fixture over plain loopback
and the test needs no pairing, TLS or certificate pin.

## Architecture

`AGENTS.md` is the committed source of truth for implementation rules and
architecture — the server-vs-client boundary, the Bun runtime, `models.ini`
ownership, Pi sessions, settings, streaming, and the rest. (Day-to-day planning lives in
`plans/`, which is local scratch and intentionally not committed to git.)

Server settings are declared once, in `SETTINGS_REGISTRY`
(`packages/shared/src/settings.ts`), and served to every client from
`GET /api/settings/schema`. Each group is read and written at
`GET`/`PATCH /api/settings/<slug>`, which validates against a zod schema derived
from that same registry.
