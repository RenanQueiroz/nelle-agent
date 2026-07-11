# Nelle Agent

Local-first AI agent you run on your own hardware. Nelle Agent is a monorepo — a
Bun server that manages a local `llama.cpp` runtime and runs the Pi agent
harness, plus the clients that connect to it — meant to ship as a single
cross-platform installer.

Today the client is a browser UI (`apps/web`, React/Vite/Astryx); a Flutter
desktop + mobile client is next. The server (`apps/server`) runs on Bun with
`bun:sqlite` and `Bun.serve`, and shared contracts live in `packages/shared`. It
runs on Windows, macOS, and Linux.

## Current MVP

Implemented:

- Bun.serve API server with browser-opened app flow.
- React/Vite UI using Meta Astryx components, React Compiler, and generated
  Astryx agent guidance.
- Frontend UI surfaces are split into focused component directories with
  cross-cutting browser UI state managed through Zustand selectors. Settings
  dialog drafts, logs, and search results live outside `App.tsx` so modal edits
  do not rerender the full workbench. The composer draft, attachments, and
  status live in their own store as well, so typing a prompt never rerenders
  the chat transcript.
- Viewport-bounded workbench layout where the sidebar and chat history manage
  their own scrolling while the chat composer stays docked over an opaque
  backdrop. Opening a conversation pins the transcript to the newest message.
- Reasoning support for thinking models:
  - A per-conversation level (`off`, `low`, `medium`, `high`, `max`) switched
    from the composer, driving Pi's thinking level on the fly. New chats start
    at `max`, which is inert on models whose chat template has no thinking mode.
  - Thinking renders as a collapsible block above the answer, streamed live from
    llama.cpp's `reasoning_content` field and persisted with the conversation.
  - Per-level token budgets in Settings (llama.cpp's own 512 / 2048 / 8192
    defaults), applied as `thinking_budget_tokens`. `max` is uncapped.
- Managed `llama.cpp` runtime control:
  - Linux installs/updates by building latest `ggml-org/llama.cpp` master.
  - Windows/macOS install/update code downloads latest GitHub release assets.
  - Runtime start/stop uses router mode with `--models-preset` and
    configurable `--models-max` and `--sleep-idle-seconds` values.
  - The router pid is persisted under `.nelle/llama/` so a restarted
    server can adopt and stop the llama-server it previously started.
  - The runtime UI can show the llama-server log tail for startup/configuration
    diagnostics and the router-reported loaded/maximum model capacity.
- Hugging Face GGUF search and quant selection that lets `llama-server`
  download/cache the model via `hf-repo`.
- Stable llama.cpp/OpenAI model ids for new Hugging Face imports, plus a
  lossless `models.ini` catalog parser/writer that preserves comments and
  unknown keys while updating Nelle-managed fields. New imports, alias edits,
  duplicates, removals, and free-form params write `models.ini` first; the app
  `state.json` mirrors that catalog as a compatibility backup.
- SQLite schema/migration foundation in `.nelle/settings.sqlite`, including
  timestamped database backups under `.nelle/backups/` before applying schema
  migrations or repairing missing migration records. Conversation list/snapshot
  APIs bind each new conversation to a header-only Nelle-owned Pi JSONL session
  file under `.nelle/pi/sessions`, and SQLite stores the UI projection for the
  active Pi branch. On Pi-enabled startup, any non-empty legacy default
  chat still present in `.nelle/state.json` is migrated into a real Pi session
  before session validation; when there is no legacy chat to migrate, no
  placeholder conversation is created, so deleting every conversation leaves an
  empty sidebar. If a bound Pi session file is missing or malformed,
  Nelle marks the conversation unavailable and surfaces `session_unavailable`
  instead of creating a replacement session under the same conversation id.
  Conversation snapshot reads reopen the bound Pi session file and rebuild the
  active timeline projection when needed, so restart recovery does not depend on
  stale SQLite projection rows.
- Conversation-scoped chat streaming through
  `/api/conversations/:id/chat/stream`.
- Chat streams are sent as Nelle SSE envelopes with monotonic event ids, stable
  run ids, `run.started` / `run.completed` terminal run events, and
  `message.assistant.completed` final assistant events. Stream `error` events
  carry stable `NelleError` codes such as `conversation_busy`. The browser
  client still accepts older raw stream events for tests and compatibility.
- Nelle-owned llama.cpp router facade endpoints under `/api/llama/*` for router
  props, model list/reload, model load/unload, per-model props, and model SSE
  events.
- A modal Astryx Settings dialog with Runtime, Models, Global Params, and Chats
  sections. Settings owns llama.cpp install/start/stop/logs, HF GGUF
  search/import, model alias editing, free-form model/global `models.ini`
  params, model duplicate/remove, load/unload/reload actions, router-capacity
  status, archive import, and clear-all chats.
- The compact composer model selector is searchable, groups browser-local
  favorites first, shows router status/progress and loaded-model metadata, and
  subscribes to router SSE updates while loading an unloaded router model before
  activating it for the next chat turn. If the router later unloads the active
  selected model, chat submit loads it again before sending the prompt.
- Settings marks models used by active runs and disables unload/save/remove for
  those rows until the run emits a terminal event.
- Pi SDK chat harness configured against the local OpenAI-compatible
  Nelle llama.cpp proxy with v1 host file/shell tools enabled.
- Direct llama.cpp chat-completions fallback if Pi initialization fails.
- Chat message metadata shows llama.cpp prompt-processing and generation
  throughput in tokens/sec when the server reports those timings.
- The chat composer shows context-window usage in its header with an Astryx
  progress bar and used/total token tooltip. The UI uses selected-model props
  for `n_ctx` when available and updates live from streamed llama.cpp metrics.
- Chat workflow errors and warnings render through Astryx `ChatComposer` status:
  send-blocking errors appear above the composer, while near-full context and
  other non-blocking chat warnings appear below it.
- Composer attachments for text files, PDFs, and images:
  - The client posts the bytes to `POST /api/uploads` and sends the message with
    `attachments: [{uploadId}]`. The server classifies the file, refuses a binary
    posing as text, and extracts PDF text.
  - A PDF with a text layer is sent as text, on any model. A scan has no text to
    send, so its pages are rendered server-side and sent as images, which needs a
    vision model. There is no switch: the server decides from the document.
  - A message whose images would leave Pi no room to reply is refused before the
    run, naming the context size that would fit. The attachment drawer appears
    with the first attachment.
  - Draft uploads live under `.nelle/uploads/` and are swept 24h after the last
    unsent one. Sent image payloads are stored content-addressed under
    `.nelle/attachments/`; attachment metadata is stored in SQLite and shown on
    user messages.
  - Audio/video attachments are not exposed yet.
- Assistant message footers show the model alias snapshot, copy action, and
  regenerate controls. The footer model menu can load another configured router
  model and call `/api/conversations/:id/messages/:messageId/regenerate` with a
  model override.
- Tool calls stream as a single status row per Pi `toolCallId` and can be
  expanded in the chat UI to inspect captured input and output.
- Host file/shell tools are disabled until the user acknowledges the
  unsandboxed local-permissions warning in Settings. The same Settings tab can
  disable tools globally, which resets cached Pi sessions so new runs use the
  current tool registry. Tool executions persist to SQLite audit rows and export
  as `tool-audit.jsonl` in `.nelle-chat.zip` archives.
- Conversation duplicate and user-message fork actions create new Nelle
  conversations backed by new Pi session files via
  `SessionManager.createBranchedSession()`. Source conversations are left
  unchanged, and Nelle copies retained sidecar metadata such as attachment
  summaries, model snapshots, timings, and tool-call details.
- Conversation export/import uses local `.nelle-chat.zip` archives with a
  manifest, checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, and model snapshot metadata. Imports always create a new
  conversation.
- Server startup sweeps orphan files under `.nelle/attachments/` that are no
  longer referenced by SQLite attachment metadata, and unbound uploads older than
  24 hours under `.nelle/uploads/`, hourly thereafter. Direct hard delete removes
  the conversation's Pi session file, its uploads, and unreferenced attachments.
- The composer stop action calls `/api/conversations/:id/abort`, aborts the
  active browser stream, and invokes Pi `AgentSession.abort()` for the cached
  conversation runtime when one is active. The internal llama.cpp proxy forwards
  close/abort signals to the downstream llama.cpp fetch.
- After the first assistant response in a fallback-titled conversation, Nelle
  asks llama.cpp for a concise title through the local proxy without persisting
  that prompt in Pi history.
- Playwright e2e test harness for the browser UI.

Not implemented yet:

- Mobile LAN pairing and push notifications (for the coming Flutter client).
- Packaging and a launcher. There is no `bin` entrypoint or installer; `bun run start`
  runs the server and `--open` launches the system browser.
- A first-run setup wizard. Runtime install, model import, and parameter editing
  all live in the Settings dialog rather than a guided onboarding flow.
- Full Pi branch tree explorer. The v1 browser UI shows the active path,
  regenerate variants, duplicate, and fork flows, while inactive branches remain
  preserved in Pi session files.
- Host-tool sandboxing and per-tool permission prompts. The current v1 gate is
  acknowledgement plus a global enable/disable switch.
- Full SQLite app-state persistence. Nelle still uses `.nelle/state.json` for
  runtime settings, catalog backup, and direct-fallback default-conversation
  compatibility, while Pi-enabled startup migrates a non-empty legacy default
  chat into a Pi session. Conversation projections live in
  `.nelle/settings.sqlite` and `models.ini` owns the model catalog. Existing
  SQLite schema migration paths back up `settings.sqlite`, but the broader
  state/Pi/attachment migration runner is still future work.
- Progress streaming for long installs/builds.

## Roadmap

- **Flutter client, desktop + mobile.** One Dart codebase to replace the React
  web app across macOS/Windows/Linux desktop and iOS/Android — chosen for low
  runtime memory (the server may share a memory-constrained box such as a Mac
  mini) and a single client to maintain. The server's REST + typed-SSE contract
  is frozen to keep this a drop-in.
- **Single cross-platform installer.** Ship the Bun server (`bun run
build:binary`, per platform) and the client as one executable. The Linux-x64
  binary is validated — it builds, boots, serves, and renders PDF pages via
  `@napi-rs/canvas` inside the compiled binary; macOS-arm64 and Windows-x64 still
  need a CI matrix and an on-target pass (including the llama-server process
  lifecycle).
- **First-run setup wizard**, host-tool sandboxing, and a full Pi branch-tree
  explorer (see "Not implemented yet" above).

## Setup

Use Bun 1.3+. The server, tests, and toolchain all run on Bun — there is no
npm/Node runtime dependency.

```bash
bun --version
bun install
```

## Run

Development mode starts the API server and Vite web server:

```bash
bun run dev
```

The API server listens on `127.0.0.1:8787`. The Vite UI listens on
`127.0.0.1:5173` and proxies `/api` to the server.

Run the server alone:

```bash
bun run dev:server
```

Run a built/static UI through the server:

```bash
bun run build
bun run start
```

Set these environment variables when needed:

- `NELLE_DATA_DIR`: override the default `.nelle/` app data directory.
- `NELLE_PORT`: change the local API port.
- `NELLE_HOST`: change the bind host.
- `LLAMA_SERVER_PATH`: use an existing `llama-server` binary instead of the
  managed install.
- `NELLE_PI_DISABLED=1`: bypass Pi and use direct llama.cpp chat completions.

## llama.cpp Flow

1. Search Hugging Face and choose a GGUF quant.
2. Click `Install` to install/update `llama.cpp`.
3. Optionally adjust max loaded models or idle sleep seconds. These launch
   settings require a `llama.cpp` restart to take effect.
4. Click `Start` to launch `llama-server` with the generated
   `.nelle/llama/models.ini`.
5. Chat with Nelle through the browser UI.
6. Use `New chat` to create a separate Pi-backed conversation, or use a
   conversation row's action menu to reset/delete/rename/pin that conversation.

The conversation sidebar lists pinned and recent chats as Astryx `SideNavItem`
rows with counts per section, a hover- and focus-revealed row action menu, and a
search field that filters titles. Long lists stay virtualized.

Submitting a prompt shows it in the transcript immediately, followed by a
`Loading weights NN%` placeholder while llama.cpp loads the model, so a cold
start is visible where the conversation is rather than only in the model picker.

Models default to a 16384-token context window. That default exists because Pi's
agent system prompt costs about 4k tokens and Pi reserves another 4096 before it
allocates any reply tokens; with an 8k window Pi asks llama.cpp for a single
token and the answer stops after one word. Nelle warns in the composer when a
prompt leaves no usable reply budget.

The chat composer uses Astryx's default up-arrow send/stop button. The footer is
reserved for model selection so the composer exposes only one send affordance;
conversation reset/delete/pin/rename live in the conversation row action menu.
The composer stays interactive while a run streams, so stop is always clickable;
sending during a run is rejected with a composer warning and the draft is kept.

The composer header shows context-window usage with a used/total token tooltip.
Near-full context is shown as a bottom composer warning, and context overflow or
other send-blocking chat errors appear above the composer. Nelle supports
`/compact [instructions]` through Astryx slash-command typeahead by calling Pi
`AgentSession.compact()` through its compact stream endpoint; completion stores
a llama.cpp `/tokenize` context estimate and emits `context.updated`. Commands
such as `/new`, `/resume`, `/model`, `/login`, and `/logout` stay owned by
Nelle UI controls. Composer stop calls Nelle's run abort endpoint for active
streamed compactions, with `AgentSession.abortCompaction()` as the server-side
Pi cancellation primitive.
The composer
attachment drawer accepts text files, PDFs, and images. Text/PDF attachments are
sent as extracted text by default; vision-capable models expose a PDF-as-image
toggle that renders pages as image attachments. Images require selected-model
vision support from llama.cpp model props. Audio/video attachments are
intentionally excluded for now.

Assistant message metadata shows the message time, the model alias that
generated the assistant response, copy/regenerate actions, visible copy
feedback, and a toggleable llama.cpp statistics widget. Reading shows prompt
tokens, prompt processing time, and prompt processing speed; Generation shows
generated tokens, generation time, and generation speed. The footer model menu
regenerates that answer with a selected configured model without changing the
composer model.
Nelle points Pi at an internal `/api/llama-proxy/v1` provider, which forwards
requests to llama.cpp unchanged except for enabling `return_progress`,
`sse_ping_interval`, and `timings_per_token` on streamed requests. The proxy
observes llama.cpp `prompt_progress` and `timings` chunks so the UI can mirror
llama.cpp's own prompt-processing and token-generation speed calculations. The
proxy also forwards request/response close events as an upstream `AbortSignal`.
The router `/slots?model=...` monitor remains a best-effort fallback and does
not overwrite exact streamed timings. After a user stop, Nelle also checks
`/slots` for up to five seconds; if llama.cpp still reports an active
generation, the abort response includes a `llama_slot_still_processing` warning
that the composer surfaces with guidance to use Settings > Runtime stop/restart
controls.
Pi tool execution events are correlated by `toolCallId`, so a running tool row
updates in place when progress or completion arrives instead of rendering
separate running and complete rows. Expand the tool row to inspect the captured
tool input and output.

For Hugging Face selections, Nelle stores the repo/quant reference and writes an
`hf-repo` entry into `models.ini`, for example:

```ini
[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

The `hf-repo` line uses the same model selection as launching `llama-server`
with:

```bash
llama-server -hf unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
```

The model file download and cache are handled by `llama.cpp`.
Nelle does not register local GGUF filesystem paths; model
selection is currently Hugging Face `hf-repo` only.
Nelle keeps the exact Hugging Face ref for `hf-repo`, but canonicalizes the
router section and OpenAI `model` id the same way llama.cpp does. For example,
`UD-Q4_K_XL` is exposed by llama.cpp as `Q4_K_XL`. Every model is registered
with Pi's `qwen-chat-template` compatibility, which is Pi's name for sending
`chat_template_kwargs.enable_thinking`. Qwen3 and Gemma 4 both read that kwarg;
a template that does not simply ignores it. Whether the reasoning control is
offered for a model is decided from the chat template llama.cpp reports on
`/props`, not from the model's name.
Generated presets do not set `n-gpu-layers` by default; llama.cpp uses its own
default unless GPU offload is explicitly configured.
If free-form model parameters make llama-server fail to start, use `Show logs`
in the runtime panel to inspect the llama-server output.
Nelle writes `.nelle/llama/llama-server.pid.json` when it starts the router.
On restart, Nelle validates that pid against the managed `models.ini` command
line before treating the runtime as controllable. If the configured port already
has a healthy llama.cpp server but no managed pid, Nelle reports it as running
and does not start another process.

On Linux, install/update builds from latest upstream master and may require
`git`, `cmake`, `make`, `gcc`, `g++`, OpenSSL headers, and optionally CUDA
tooling. It is intentionally user-triggered because it can take several minutes.

## Checks

```bash
bun run format:check
bun run lint
bun run check
bun run test:unit
bun run build:web
bun run test:e2e
bun run test
```

Formatting and linting use Oxfmt and Oxlint with repo-local config files:
`.oxfmtrc.json` and `.oxlintrc.json`. `bun run test` runs format check, lint, unit
tests, TypeScript, and the web build. Playwright e2e remains a separate
explicit check.

Useful Oxc commands:

```bash
bun run format
bun run lint:fix
```

`bun run test:e2e` starts an isolated server on `127.0.0.1:8799`, stores test
data in `.nelle-e2e/`, and runs Chromium Playwright tests from `tests/e2e`.
Install the browser once with:

```bash
npx playwright install chromium
```

Useful Playwright commands:

```bash
bun run test:e2e:headed
bun run test:e2e:ui
bun run test:e2e:report
```

Codex is configured locally with the Playwright MCP server in
`~/.codex/config.toml`. Restart the Codex session after config changes so the
tool is available. Claude Code should use the existing Playwright plugin rather
than a separate local MCP entry.

Useful smoke probes after starting the server:

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8787/api/state
curl -fsS 'http://127.0.0.1:8787/api/huggingface/search?q=tiny%20gguf'
```

## Architecture

`AGENTS.md` is the committed source of truth for implementation rules and
architecture — server-vs-client boundaries, the Bun runtime, `models.ini`
ownership, settings, streaming, and the rest. (Day-to-day planning lives in
`plans/`, which is local scratch and intentionally not committed to git.)

Server settings are declared once, in `SETTINGS_REGISTRY`
(`packages/shared/src/settings.ts`), and served to every client from
`GET /api/settings/schema`. Each group is read and written at
`GET`/`PATCH /api/settings/<slug>`, which validates against a zod schema derived
from that same registry.
