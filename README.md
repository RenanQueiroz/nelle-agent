# Nelle Server

Local-first server POC for Nelle Agent.

Nelle Server manages a local `llama.cpp` runtime, runs the Pi agent harness,
serves a browser-based Astryx/React setup and chat UI, and exposes the API that
the separate React Native mobile app (`nelle-client`) will consume later.

## Current POC

Implemented:

- Fastify API server with browser-opened app flow.
- React/Vite UI using Meta Astryx components, React Compiler, and generated
  Astryx agent guidance.
- Viewport-bounded workbench layout where side panels and the chat history
  manage their own scrolling while the chat composer stays docked.
- Managed `llama.cpp` runtime control:
  - Linux installs/updates by building latest `ggml-org/llama.cpp` master.
  - Windows/macOS install/update code downloads latest GitHub release assets.
  - Runtime start/stop uses router mode with `--models-preset` and
    configurable `--models-max` and `--sleep-idle-seconds` values.
  - The router pid is persisted under `.nelle/llama/` so a restarted
    `nelle-server` can adopt and stop the llama-server it previously started.
  - The runtime UI can show the llama-server log tail for startup/configuration
    diagnostics.
- Hugging Face GGUF search and quant selection that lets `llama-server`
  download/cache the model via `hf-repo`.
- Stable llama.cpp/OpenAI model ids for new Hugging Face imports, plus a
  lossless `models.ini` catalog parser/writer that preserves comments and
  unknown keys while updating Nelle-managed fields. New imports, alias edits,
  duplicates, removals, and free-form params write `models.ini` first; the POC
  `state.json` mirrors that catalog as a compatibility backup.
- SQLite schema/migration foundation in `.nelle/settings.sqlite`, plus
  conversation list/snapshot APIs. Each active conversation is bound to a
  Nelle-owned Pi JSONL session file under `.nelle/pi/sessions`, and SQLite
  stores the UI projection for the active Pi branch.
- Conversation-scoped chat streaming through
  `/api/conversations/:id/chat/stream`, with the legacy `/api/chat/stream`
  route kept as a default-conversation compatibility wrapper.
- Chat streams are sent as Nelle SSE envelopes with monotonic event ids, stable
  run ids, `run.started` / `run.completed` terminal run events, and
  `message.assistant.completed` final assistant events. The browser client still
  accepts older raw stream events for tests and compatibility.
- Nelle-owned llama.cpp router facade endpoints under `/api/llama/*` for router
  props, model list/reload, model load/unload, per-model props, and model SSE
  events.
- A right-side Settings panel with Runtime, Models, Global Params, and Chats
  sections. Settings owns llama.cpp install/start/stop/logs, HF GGUF
  search/import, model alias editing, free-form model/global `models.ini`
  params, model duplicate/remove, load/unload/reload actions, archive import,
  and clear-all chats.
- The compact composer model selector is searchable, groups browser-local
  favorites first, shows router status/progress and loaded-model metadata, and
  subscribes to router SSE updates while loading an unloaded router model before
  activating it for the next chat turn.
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
  - Text files and PDFs are extracted client-side and sent to Pi as text by
    default.
  - Images, and PDFs rendered as page images, are sent through Pi's structured
    image input only when the selected llama.cpp model reports vision support.
  - Sent image payloads are stored content-addressed under `.nelle/attachments/`;
    attachment metadata is stored in SQLite and shown on user messages.
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
  longer referenced by SQLite attachment metadata, while direct hard delete
  removes the conversation's Pi session file and unreferenced attachments.
- The composer stop action calls `/api/conversations/:id/abort`, aborts the
  active browser stream, and invokes Pi `AgentSession.abort()` for the cached
  conversation runtime when one is active. The internal llama.cpp proxy forwards
  close/abort signals to the downstream llama.cpp fetch.
- After the first assistant response in a fallback-titled conversation, Nelle
  asks llama.cpp for a concise title through the local proxy without persisting
  that prompt in Pi history.
- Playwright e2e test harness for the browser UI.

Not implemented yet:

- Mobile LAN pairing and Expo push.
- Remaining Pi-backed conversation lifecycle polish. The server now maps each
  Nelle conversation to one Pi session file and reopens that file on demand.
  The web UI uses an Astryx `SideNav` shell with a collapsible virtualized
  conversation sidebar, search, pinned and recent sections, running indicators,
  and row actions for pin, rename, reset, duplicate, and delete. Assistant
  regeneration uses Pi branch replay with preserved visible answer variants,
  and user-message fork creates new conversations from persisted Pi entries.
  The composer has an Astryx `/compact` typeahead, composer-local unsupported
  slash-command guidance, visible compaction status rows, and local
  `.nelle-chat.zip` export/import. Slot-level abort verification is still
  pending.
- Llama.cpp slot-level abort verification and authoritative post-compaction
  context token recalculation.
- Host-tool sandboxing and per-tool permission prompts. The current v1 gate is
  acknowledgement plus a global enable/disable switch.
- Full SQLite app-state persistence. The POC still uses `.nelle/state.json` for
  runtime settings, catalog backup, and default-conversation compatibility,
  while conversation projections live in `.nelle/settings.sqlite` and
  `models.ini` owns the model catalog.
- Progress streaming for long installs/builds.

## Setup

Use Node 22.18+ on the 22.x line, or Node 24.11+:

```bash
node --version
npm install
```

## Run

Development mode starts the API server and Vite web server:

```bash
npm run dev
```

The API server listens on `127.0.0.1:8787`. The Vite UI listens on
`127.0.0.1:5173` and proxies `/api` to the server.

Run the server alone:

```bash
npm run dev:server
```

Run a built/static UI through the server:

```bash
npm run build
npm start
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

The chat composer uses Astryx's default up-arrow send/stop button. The footer is
reserved for model selection so the composer exposes only one send affordance;
conversation reset/delete/pin/rename live in the conversation row action menu.

The composer header shows context-window usage with a used/total token tooltip.
Near-full context is shown as a bottom composer warning, and context overflow or
other send-blocking chat errors appear above the composer. Nelle supports
`/compact [instructions]` through Astryx slash-command typeahead by calling Pi
`AgentSession.compact()` directly; commands such as `/new`, `/resume`, `/model`,
`/login`, and `/logout` stay owned by Nelle UI controls. Composer stop calls
Nelle's run abort endpoint for active streamed compactions, with
`AgentSession.abortCompaction()` as the server-side Pi cancellation primitive.
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
not overwrite exact streamed timings.
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
Nelle does not register local GGUF filesystem paths in the active POC; model
selection is currently Hugging Face `hf-repo` only.
Nelle keeps the exact Hugging Face ref for `hf-repo`, but canonicalizes the
router section and OpenAI `model` id the same way llama.cpp does. For example,
`UD-Q4_K_XL` is exposed by llama.cpp as `Q4_K_XL`. Qwen-family models are
registered with Pi's `qwen-chat-template` compatibility so `thinkingLevel: off`
sends
`chat_template_kwargs.enable_thinking = false` and responses stream visible
assistant text instead of hidden-only reasoning.
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
npm run format:check
npm run lint
npm run check
npm run test:unit
npm run build:web
npm run test:e2e
npm test
```

Formatting and linting use Oxfmt and Oxlint with repo-local config files:
`.oxfmtrc.json` and `.oxlintrc.json`. `npm test` runs format check, lint, unit
tests, TypeScript, and the web build. Playwright e2e remains a separate
explicit check.

Useful Oxc commands:

```bash
npm run format
npm run lint:fix
```

`npm run test:e2e` starts an isolated server on `127.0.0.1:8799`, stores test
data in `.nelle-e2e/`, and runs Chromium Playwright tests from `tests/e2e`.
Install the browser once with:

```bash
npx playwright install chromium
```

Useful Playwright commands:

```bash
npm run test:e2e:headed
npm run test:e2e:ui
npm run test:e2e:report
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

Current planning source of truth:

- [Architecture plan](plans/nelle-agent-architecture.md)
- [Router and chat UI plan](plans/nelle-router-chat-ui-plan.md)
