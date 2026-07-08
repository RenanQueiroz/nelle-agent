# Nelle Agent Architecture Plan

Last updated: 2026-07-08

## Working Goal

Nelle Agent is a local-first server app that runs on Windows, macOS, and Linux.
It manages a local `llama.cpp` server, uses Pi as the agent harness, and
exposes a web UI plus an API that a separate React Native app (`nelle-client`)
can use for chat, status, and notifications.

The first product experience should be UI-driven:

1. Launch Nelle Agent.
2. Complete first-run setup in a local web/desktop UI.
3. Pick a GGUF model and quant from Hugging Face.
4. Configure practical `llama.cpp` parameters without editing raw config files.
5. Start or stop the model server.
6. Chat with the agent from the browser UI.
7. Pair a phone on the same LAN and chat from `nelle-client`.

## Confirmed Upstream Constraints

- Pi is a TypeScript/Node agent harness with SDK, RPC, and JSON event stream
  integration modes. SDK embedding is the least-friction path for a Node app.
  Reference: https://pi.dev/docs/latest/sdk
- Pi can add local OpenAI-compatible providers and models through `models.json`.
  For local servers, Pi expects an API key value or configured auth even when the
  server ignores it. Compatibility flags can disable unsupported OpenAI fields.
  Reference: https://pi.dev/docs/latest/models
- Pi does not sandbox file, process, network, or credential access. If Nelle
  enables file/shell/tool actions, Nelle must own the permission and isolation
  model rather than treating Pi project trust as a security boundary.
  Reference: https://pi.dev/docs/latest/security
- `llama-server` router mode starts when no single `--model` is supplied. It can
  discover cached models, scan a `--models-dir`, or use `--models-preset`.
  Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#using-multiple-models
- `--models-preset` accepts an INI file. Each section is a model preset, keys map
  to `llama-server` CLI flags, `[*]` supplies global defaults, and preset-only
  keys include `load-on-startup` and `stop-timeout`.
  Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#model-presets
- Router requests are routed by the request `model` field for OpenAI-style POST
  endpoints. `--models-max` limits how many models can be loaded at once.
  Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#routing-requests
- llama.cpp exposes live slot monitoring through `/slots`, prompt processing
  progress through streamed `prompt_progress` when `return_progress` is enabled,
  and timing fields such as `timings.prompt_per_second` and
  `timings.predicted_per_second` on streamed OpenAI-compatible responses when
  `timings_per_token` is enabled or the response is final.
  Reference: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- Hugging Face supports GGUF metadata and llama.cpp can consume GGUF models from
  the Hub. The Nelle model picker should be GGUF-first.
  References: https://huggingface.co/docs/hub/en/gguf and
  https://huggingface.co/docs/hub/en/gguf-llamacpp
- `expo-notifications` supports Expo push tokens and the Expo Push Service for
  real iOS/Android push notifications. Android remote push is not available in
  Expo Go from SDK 53 onward, so the mobile app needs a development/release
  build for push testing.
  Reference: https://docs.expo.dev/versions/latest/sdk/notifications/
- Astryx provides the UI component system, CLI, design tokens, themes, and
  AI-agent context generation. The installed agent context says to run
  `npx astryx build "<idea>"` before writing UI, inspect templates and component
  docs, import Astryx reset/core CSS in the app entry, and avoid raw layout
  primitives or magic styling values.
  References: https://astryx.atmeta.com/docs/getting-started and
  https://astryx.atmeta.com/docs/working-with-ai
- Pi slash commands include model, session, auth, settings, history, and
  compaction commands. Nelle should not forward arbitrary Pi slash commands
  from chat input because several of them conflict with Nelle-owned UI flows.
  `/compact [prompt]` is the only Pi slash command planned for direct composer
  support initially.
  References: https://pi.dev/docs/latest/usage#slash-commands and
  https://pi.dev/docs/latest/compaction

## Settled Decisions

- No Electron for the first implementation. Nelle Server starts a local web
  server and opens the user's browser.
- Nelle Server is personal single-user software for v1.
- Host file and shell tools are v1 scope. They run with the permissions of the
  user account that launched Nelle. Sandboxing comes later.
- The model picker should expose broad Hugging Face search, filtered to GGUF
  models that can run in `llama.cpp`.
- Nelle manages `llama.cpp` binaries:
  - Linux builds from latest `ggml-org/llama.cpp` master.
  - Windows and macOS download latest official GitHub release assets.
  - The UI exposes start, stop, update availability, and update actions.
- Same-LAN HTTP plus pairing tokens is acceptable initially.
- Mobile notifications should be real push notifications through
  `expo-notifications` and the Expo Push Service.
- Text chat only. Voice/audio is out of v1 scope. Composer attachments are
  limited to text files, PDFs, and images for the router/chat UI plan.
- The default router capacity is one loaded model, but `modelsMax` is
  user-configurable. The product should not assume most users can run multiple
  large local models concurrently.
- The web UI uses Meta's Astryx components and design tokens.
- Chat slash commands are Nelle allowlisted. Support `/compact [instructions]`
  first, and route session, model, auth, settings, export, and copy workflows
  through Nelle UI controls instead of Pi's interactive slash commands.
  `/compact` should call Pi `AgentSession.compact()` directly, and stop during
  compaction should call `AgentSession.abortCompaction()`.
- Each Nelle conversation maps to exactly one Pi session JSONL file. Pi owns
  message history, compaction, and branch/tree state; SQLite owns Nelle's
  conversation index, projections, and sidecar UI metadata.
- Forking and duplicating conversations are in scope for the conversation UI.
  They should use Pi runtime fork/clone behavior and create new Nelle
  conversations backed by new Pi session files.
- Nelle should support multiple active Pi conversation runtimes when Pi and the
  local router can support them, while enforcing only one active run per
  conversation.
- UI stop/abort calls Pi `AgentSession.abort()` and propagates cancellation
  through Nelle's llama.cpp proxy request. If llama.cpp keeps a slot generating,
  Nelle warns and exposes a manual runtime stop/restart action.
- `models.ini` editing uses a lossless AST parser/writer that preserves
  comments, ordering, unknown keys, and untouched user edits. Hugging Face
  imports keep exact `hf-repo` refs while using stable canonical section ids.
- This directory should be initialized as a real Git repo with origin
  `git@github.com:RenanQueiroz/nelle-agent.git`.

## Current Recommendation

Use a TypeScript-first stack:

- Local app/server: Node.js + Fastify + REST/SSE.
- Launch surface: a small cross-platform CLI/server entrypoint that starts the
  local server and opens the setup/admin UI in the system browser.
- Admin UI: React + Vite + TypeScript + Astryx + React Compiler.
- Agent harness: Pi SDK embedded in the Node server through a dedicated
  `PiBridge`.
- Model runtime: official `llama.cpp` release binaries managed as sidecar
  executables by Nelle on Windows/macOS; source-built binaries managed by Nelle
  on Linux.
- Mobile client: separate React Native repo that talks to the server over a
  versioned HTTP/SSE API on LAN. WebSocket can be added later behind the same
  event envelope if mobile background constraints require it.
- Persistence: SQLite for app metadata, plus filesystem storage for
  user-editable llama router presets, Pi sessions, logs, and downloaded
  binaries.
- Streaming contract: typed SSE envelopes for conversation runs, Pi/tool
  events, performance/context updates, model status, compaction, aborts, and
  errors.

Why this default:

- Pi is already a Node/TypeScript system, so SDK embedding avoids a subprocess
  protocol boundary for the core agent loop.
- Avoiding Electron keeps baseline memory lower while the local model consumes
  most of the host's available memory.
- React web plus React Native keeps UI patterns, generated API clients, and
  validation schemas aligned across desktop and mobile.
- Astryx gives the browser UI an opinionated component system, design tokens,
  page/block templates, and CLI-readable docs that AI agents can follow.
- Future native wrappers or tray helpers can be added after the server and model
  management flows are stable.

Frontend conventions:

- Build the web app with React Compiler through `@vitejs/plugin-react`'s
  `reactCompilerPreset()` and `@rolldown/plugin-babel`.
- Keep the workbench viewport-bounded: the document body should not be the
  primary scroll container. Side panels and the chat history own their own
  overflow, and the chat composer remains docked at the bottom of the chat
  column.
- Import Astryx CSS once in the web app entry:

```ts
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
```

- Wrap the React app in Astryx `Theme`, using the prebuilt neutral theme when
  paired with `theme.css`:

```tsx
import {Theme} from '@astryxdesign/core';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';

<Theme theme={neutralTheme}>
  <App />
</Theme>;
```

- Before building a new UI surface, run `npm run astryx -- build "<idea>"`,
  then inspect the recommended template and component docs.
- Prefer Astryx layout/components over raw HTML structure for app UI.
- Use Astryx tokens for spacing, color, radius, and typography.
- For slash-command UI, use Astryx `ChatComposerInput` triggers with a
  searchable source and `TypeaheadItem` descriptions, following the
  `ChatComposerInputSlashCommands` template.
- Let Astryx `ChatComposer` render its default `ChatSendButton` unless the UI is
  intentionally replacing it via `sendButton`; `sendActions` is for auxiliary
  controls to the left of send and should not render another send affordance.
- Astryx does not currently provide a reusable virtual sidebar list primitive
  for conversation history. Use `@tanstack/react-virtual` for the conversation
  sidebar's flattened row model, while keeping Astryx `SideNav`/`List` styling,
  tokens, menus, and tooltips around those rows.
- Do not introduce Tailwind, StyleX, or custom styling systems unless a concrete
  Astryx limitation forces that decision.

Keep a seam for an alternate Pi runtime:

- Define `AgentHarness` as an internal interface.
- Start with `PiSdkHarness`.
- Keep `PiRpcHarness` as a possible later implementation if SDK coupling,
  process isolation, or Pi upgrade cadence becomes painful.

## Proposed Repo Shape

```text
apps/
  server/               Fastify API, Pi bridge, runtime managers, launcher
  web/                  React setup/admin/chat UI
packages/
  shared/               Shared TypeScript types, Zod schemas, API contracts
  db/                   SQLite schema and migrations
  hf/                   Hugging Face search/catalog helpers
  llamacpp/             Binary install, preset generation, process control
  pi-bridge/            Pi SDK adapter and event normalization
  notifications/        Pairing, LAN delivery, future push-provider adapter
  launcher/             Open-browser helper and host integration utilities
plans/
  nelle-agent-architecture.md
  nelle-router-chat-ui-plan.md
AGENTS.md               Astryx-generated Codex agent UI guidance
.claude/CLAUDE.md       Astryx-generated Claude Code UI guidance
```

This repo owns the local server, browser UI, launcher, and host runtime
management. `nelle-client` should consume a generated API client and shared
protocol docs, but should remain a separate repo.

Companion implementation plans:

- [Router and chat UI plan](nelle-router-chat-ui-plan.md): router-mode model
  lifecycle, `models.ini` ownership, settings, sidebar, conversations, and
  generated chat titles.

## Current POC Status

The first POC implements the local Fastify server, React/Vite browser UI,
Astryx chat surface, Hugging Face GGUF search, Hugging Face quant selection
through llama.cpp-managed `hf-repo` references, managed `llama.cpp`
install/update/start/stop paths, a lossless writer for router `models.ini`, Pi
SDK chat streaming, a direct llama.cpp fallback for diagnostics,
browser-triggered conversation reset, SQLite schema/migration foundations,
conversation list/snapshot APIs, and Playwright e2e coverage for the browser
workbench. The runtime UI also exposes a llama-server log tail for startup and
configuration diagnostics.

Intentional POC limitations:

- Model/chat state is still stored in `.nelle/state.json`; SQLite currently
  stores conversation schema foundations and a mirrored POC conversation, but is
  not yet the primary app-state database.
- Long-running install/build progress is not streamed yet.
- Mobile LAN pairing and Expo push are still future milestones.
- Host tools are enabled through Pi and remain unsandboxed.
- The UI is adapted from Astryx `ai-chat` and `ai-chat-landing` templates, but
  the raw generated template files are not kept in `src`.

## Testing And MCP Tooling

Playwright is the primary UI automation path for Nelle Server. The repo includes
`playwright.config.ts`, an isolated e2e server script, and tests under
`tests/e2e`. The e2e server runs on `127.0.0.1:8799`, resets `.nelle-e2e/`, and
builds the web UI before serving it through Fastify.

Current commands:

```bash
npm run format:check
npm run lint
npm run format
npm run lint:fix
npm run test:unit
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:ui
npm run test:e2e:report
```

Oxfmt and Oxlint are configured with `.oxfmtrc.json` and `.oxlintrc.json`.
`npm test` runs format check, lint, unit tests, TypeScript, and the web build.
Playwright e2e remains separate because it starts a browser-backed server.

Codex has a local Playwright MCP server configured through
`~/.codex/config.toml` so future Codex sessions can inspect and drive the UI.
Claude Code should use the existing Playwright plugin instead of an additional
local MCP server.

## Main Components

### Local Launcher

Responsibilities:

- Start the local server on loopback by default.
- Open the setup/admin UI in the system browser.
- Print the local URL and pairing/admin status in the terminal for early builds.
- Later provide OS-specific niceties such as background startup, a menu bar/tray
  helper, or service installation without requiring Electron.
- Optionally allow LAN binding only after explicit user approval.

### Server API

Responsibilities:

- Serve the admin UI.
- Expose REST endpoints for settings, model catalog, runtime status,
  sessions, pairing, and diagnostics.
- Expose SSE streams for chat deltas, tool events, server logs, runtime status,
  router status, and install/build progress.
- Own auth, pairing, and permission gates.
- Own all process supervision for `llama-server`.

Initial API transport:

- REST for commands and state snapshots.
- SSE for v1 browser/mobile LAN event streams.
- WebSocket is deferred unless a specific bidirectional transport need appears;
  if added, it should carry the same typed Nelle event envelopes.
- Push notifications are separate from chat/run streaming and should trigger
  snapshot refreshes rather than carry full conversation state.

### Pi Bridge

Responsibilities:

- Run Pi using a Nelle-controlled `agentDir`, not the user's global Pi config.
- Store Pi sessions under Nelle's app data directory and map one Nelle
  conversation to one Pi session file.
- Manage Pi sessions through `AgentSessionRuntime`/`SessionManager`, reopening
  existing session files on demand after Nelle server restarts.
- Use Pi runtime fork/clone behavior for Nelle fork and duplicate actions.
  Create a new Nelle conversation for the resulting Pi session file and keep the
  source conversation unchanged.
- Maintain a lazy runtime pool keyed by conversation id so multiple
  conversations can be open or streaming without replacing a single global Pi
  session.
- Generate or update Pi `models.json` for Nelle's local llama.cpp proxy
  provider.
- Use a local OpenAI-compatible provider:

```json
{
  "providers": {
    "nelle-llamacpp": {
      "baseUrl": "http://127.0.0.1:8787/api/llama-proxy/v1",
      "api": "openai-completions",
      "apiKey": "nelle-local",
      "authHeader": false,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false,
        "maxTokensField": "max_tokens"
      },
      "models": []
    }
  }
}
```

- Fill `models` from Nelle's configured llama presets.
- Proxy Pi's streamed chat-completion requests through Nelle so the server can
  add `return_progress`, `sse_ping_interval`, and `timings_per_token`, relay the
  SSE stream unchanged, and side-channel llama.cpp `prompt_progress` / `timings`
  metadata into Nelle chat events.
- Normalize Pi events into Nelle's API event contract.
- Persist sessions under Nelle's app data directory.
- Project Pi session entries into SQLite for fast UI/search, but treat Pi JSONL
  files as authoritative for message history and branch state.
- Use Pi `AgentSession.abort()`, `compact()`, `abortCompaction()`, and
  `abortRetry()` for UI stop/compact behavior rather than reimplementing those
  mechanics.
- Enable host file and shell tools in v1.
- Require explicit first-run acknowledgement before host tools are enabled,
  keep a global disable switch, and persist an audit trail for tool calls.
- Expose only Nelle-allowlisted Pi slash behavior through the web composer.
  Initially this means manual compaction through `/compact [instructions]`.
  Other Pi built-ins remain UI-owned or unsupported, and extension/skill/prompt
  slash commands stay hidden until Nelle has explicit command-level policy.

Security posture:

- Do not load arbitrary Pi project extensions by default.
- v1 is a trusted, personal, unsandboxed local agent. File and shell operations
  run as the launching OS user.
- Show an explicit first-run warning before enabling host tools.
- Log tool calls and command output for observability.
- Add user-grantable capabilities later: selected folders, command allowlists,
  MCP servers, network domains, explicit confirmation policies, and sandboxed
  execution.

### llama.cpp Runtime Manager

Responsibilities:

- Install, update, or locate `llama-server` for the current platform.
- Detect CPU/GPU capabilities enough to recommend a binary/backend.
- Maintain an app-owned llama directory and user-editable `models.ini` router
  preset.
- Start router mode with configurable loaded-model capacity, defaulting to one:

```bash
llama-server \
  --host 127.0.0.1 \
  --port <port> \
  --models-preset <app-data>/llama/models.ini \
  --models-max <configured max, default 1> \
  --sleep-idle-seconds <configured seconds, default 90>
```

- Optionally bind to LAN only when mobile pairing is enabled.
- Health-check `/models`, `/v1/models`, and model status events from
  `/models/sse`.
- Surface model load/unload status in the UI.
- Surface available updates in the UI.
- Apply updates from the UI after stopping the running server.
- Stop the whole process tree reliably on Windows, macOS, and Linux.
- Persist the router pid under `.nelle/llama/`, adopt it after `nelle-server`
  restarts, and refuse to spawn a second router when a healthy server already
  responds on the configured port.

Runtime install/update policy:

- Linux: build from latest `ggml-org/llama.cpp` master using a shallow source
  checkout, stamp the built commit, and rebuild when upstream `HEAD` changes.
- Windows: download the latest official GitHub release asset that matches the
  host architecture/backend.
- macOS: download the latest official GitHub release asset that matches Apple
  Silicon or Intel.
- Store installed binaries under app data, not inside this source tree.
- Keep update state explicit: installed version/commit, latest version/commit,
  selected backend, last update check, and last update error.
- Use `/home/renan/voice-agent/setup-llamacpp.sh` as a reference for Linux
  dependency checks, shallow source builds, release-asset downloads, helper
  binary validation, and update stamps, but implement this logic in TypeScript.

Model concurrency:

- Keep multiple configured model records in `models.ini`.
- Use router mode with `--models-max` defaulting to `1` so switching models can
  use router load/unload APIs rather than changing raw command lines.
- Expose `modelsMax` as a runtime setting; changing it requires a router
  restart.
- Pass `--sleep-idle-seconds`, defaulting to `90`, so loaded models can sleep
  when idle.
- Let llama.cpp enforce capacity and LRU unload behavior. Nelle should surface
  router status, not duplicate the router's scheduling policy.

`models.ini` example:

```ini
version = 1

[*]
c = 8192

[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
stop-timeout = 10
```

Open technical spikes:

- Verify current `llama-server` release asset naming and included binaries for
  Windows x64/arm64 and macOS arm64/x64.
- Verify Linux source builds for CPU-only and NVIDIA CUDA hosts.
- Verify process-tree cleanup on native Windows.
- Verify router preset reload behavior. Assume restart after preset changes
  until proven otherwise.
- Verify which compatibility flags Pi needs for current `llama-server`.
- Decide whether Linux Vulkan/ROCm are v1 build options or post-v1 updates.

### Hugging Face Model Manager

Responsibilities:

- Search Hugging Face for GGUF-compatible models.
- Filter broad Hub search results to repositories/files that expose model GGUF
  artifacts and enough metadata to run under `llama.cpp`.
- Derive selectable quant options from the available GGUF files, including
  multi-shard quant groups, and register the selected quant as a llama.cpp
  `hf-repo` reference instead of forcing Nelle to download the files itself.
- Show only useful model files by default, with quantization, size, license,
  architecture, downloads, and disk-space checks.
- Write llama router preset sections in `models.ini` after HF ref import.

Initial implementation:

- Preferred for normal setup: Nelle stores the selected repo/quant and writes
  `hf-repo = <repo>:<quant>` in the generated llama.cpp preset so llama.cpp owns
  download, cache, sharded-file handling, and companion `mmproj` downloads.
- Canonicalize the `models.ini` section and OpenAI `model` id the same way
  llama.cpp does. For example, `UD-Q4_K_XL` is requested from Hugging Face as-is
  but exposed through the router as `Q4_K_XL`.
- Do not write `n-gpu-layers` by default. Let llama.cpp use its own default
  unless the user explicitly configures GPU offload parameters.
- Also write `alias = <repo>:<quant>` for Hugging Face refs as user-facing
  metadata. Keep Nelle requests keyed by the stable section id and cache any
  router-reported runtime id separately.
- Register Qwen-family models in Pi with model-level
  `compat.thinkingFormat = "qwen-chat-template"` and `reasoning = true`, while
  starting sessions with `thinkingLevel: "off"`. This makes Pi send
  `chat_template_kwargs.enable_thinking = false` to local llama.cpp servers and
  avoids hidden-only `reasoning_content` responses for normal chat.
- Attach llama.cpp throughput metadata to assistant messages. Prefer exact
  streamed `prompt_progress` and `timings` values observed by Nelle's llama
  proxy or direct fallback path; use router `/slots?model=...` decoded-token
  counters only as best-effort fallback data.
- Persist the model that generated each assistant message, including a display
  alias snapshot and llama.cpp runtime model id. Assistant footers should show
  timestamp, model selector, a toggleable Reading/Generation performance stats
  widget, copy, and regenerate controls.
- The stats widget should mirror llama.cpp's shape: Reading shows prompt tokens,
  prompt processing time, and prompt processing speed; Generation shows
  generated tokens, generation time, and generation speed. Use icon controls and
  tooltips rather than long visible labels.
- Composer attachments should support text files, PDFs, and images only. Use
  model-specific `/props?model=<id>&autoload=false` metadata to gate images and
  PDF-as-image mode on `modalities.vision`; keep audio/video out of scope while
  Pi's structured input path is text plus image.
- Show context-window usage in the Astryx `ChatComposer` header with a
  `ProgressBar` and hover/focus tooltip containing used/total token counts.
  Treat streamed llama.cpp `prompt_progress` and `timings` as authoritative;
  any tokenization estimate is draft-only.
- Route chat sendability problems through Astryx `ChatComposer` status:
  blocking errors above the composer and non-blocking warnings below it.
- Add slash-command typeahead to the composer from Nelle's allowlist. Initially
  show `/compact [instructions]` only, reject unsupported Pi commands before
  prompt submission, and render manual compaction as a visible command/status
  row rather than a normal user/assistant message.
- Regenerating an assistant answer should use Pi-native branching by replaying
  the original user content on a new branch. Selecting a different model in the
  message footer should load that model if needed and regenerate with that model
  override in one action; Nelle groups regenerated answers as UI variants.
- Correlate Pi tool execution events by `toolCallId`, upsert the same tool call
  row as it moves from running to complete/error, and preserve compact input and
  output details for expandable UI inspection.
- Do not expose direct Nelle file downloads or local GGUF path registration in
  the active product. Later local-file support should still be represented as
  `models.ini` parameters rather than as a separate Nelle-owned model path API.

Open product questions:

- Should gated/private HF models be supported in the first release?
- Should we recommend quantization automatically from RAM/VRAM?

### Mobile Pairing And LAN Access

Initial same-LAN flow:

1. User enables "Allow phone access" in the desktop UI.
2. Server binds an API listener to the LAN interface or advertises a LAN URL.
3. Server shows a QR code containing URL, server identity, and a short-lived
   pairing token.
4. Mobile app scans the code and exchanges the token for a long-lived device
   credential.
5. Mobile app uses REST plus SSE for chat events and status while on LAN.
   Push notifications are delivered through Expo and cause the app to refresh
   snapshots when reachable.

Security defaults:

- No LAN binding until user opts in.
- Pairing tokens expire quickly and are single use.
- Paired devices are listed and revocable in the desktop UI.
- External access is deferred.

Important push-notification caveat:

- True iOS/Android push notifications require a push service path. For v1, the
  mobile app registers an Expo push token through `expo-notifications`, sends it
  to Nelle Server during pairing, and Nelle Server sends notification requests
  to the Expo Push Service.
- LAN HTTP remains the pairing and chat transport. Push delivery requires the
  host server to have internet access to reach Expo.
- Android remote push testing requires a development or release build, not Expo
  Go, for current Expo SDKs.

Likely path:

- Phase 1: same-LAN chat plus Expo push notifications for agent-initiated
  alerts.
- Phase 2: external access strategy. Decide between a Nelle-hosted relay,
  user-owned tunnel, Tailscale-style private network, or multiple options.

### Persistence

Store under OS app data directories:

- `settings.sqlite`: app settings, configured models, devices,
  conversation index/projections, model cache, runtime state snapshots,
  migrations.
- `llama/`: generated `models.ini`, managed router pid file, llama.cpp
  binaries, llama logs.
- `pi/`: Nelle-owned Pi `agentDir`, model config, credentials if needed,
  authoritative conversation session JSONL files.
- `logs/`: app, runtime, and diagnostic logs.

Secrets:

- Use OS secret storage for any external credentials where possible.
- HF tokens and future push-relay credentials should not live in plaintext
  SQLite.
- Mobile device credentials should be revocable and scoped.

### Setup UX

First-run screens:

1. Welcome/status: local-only explanation and platform checks.
2. llama.cpp setup: download recommended binary, use existing binary, or build
   from source on Linux.
3. Model source: broad Hugging Face GGUF search and quant selection.
4. Model parameters: free-form key/value controls for global `[*]` and
   per-model `models.ini` params, plus visible llama-server logs for invalid
   parameter diagnostics.
5. Start server: live logs and health checks.
6. Chat smoke test.
7. Pair phone: optional QR code flow.

Do not make users edit raw INI or JSON in the primary path. Keep raw config as an
advanced diagnostics/export view.

## Milestones

### Milestone 0: Planning And Spike Closure

Exit criteria:

- Pick SQLite library and migration tool.
- Confirm Pi SDK can talk to a local `llama-server` model through generated
  `models.json`.
- Implement the one-Nelle-conversation-to-one-Pi-session lifecycle and typed
  stream envelope contracts from the router/chat plan.
- Implement UI abort through Pi `AgentSession.abort()` and Nelle llama proxy
  abort propagation.
- Implement the lossless `models.ini` parser/writer and HF model id
  canonicalizer.
- Confirm `llama-server` router mode with Nelle-owned `models.ini` on this
  host.
- Confirm a first HF `hf-repo` import path.
- Confirm Linux source-build flow from latest `llama.cpp` master.
- Confirm Windows/macOS release-asset naming and update metadata.

### Milestone 1: Local Server Skeleton

Exit criteria:

- `pnpm dev` starts server and web UI.
- Health endpoint reports app version, platform, data paths, and runtime status.
- Basic settings persistence works.
- Web UI has runtime status and logs.

### Milestone 2: llama.cpp Managed Runtime

Exit criteria:

- App can install, locate, update, start, and stop `llama-server`.
- App can parse, edit, and write `models.ini` without dropping user edits.
- App can start/stop router mode with configurable `--models-max` and
  `--sleep-idle-seconds`.
- App can list router models and show loaded/unloaded status.
- App can notify the user that a runtime update is available.
- One configured Hugging Face GGUF ref can answer through
  `/v1/chat/completions`.

### Milestone 3: Pi Chat Loop

Exit criteria:

- Pi SDK uses Nelle's local llama.cpp proxy provider.
- Web UI can create a session and stream assistant output.
- Web UI displays llama.cpp prompt-processing and generation throughput beside
  assistant message timestamps when the server reports it, using a toggleable
  Reading/Generation stats view with icon tooltips.
- Web UI shows composer-local errors and warnings through Astryx
  `ChatComposer.status` rather than page-level chat notices.
- Web UI displays which model generated each assistant message and supports
  copy plus branch-based regenerate, including regenerate with a model override.
- Web UI shows each tool call once, updates its status in place, and exposes
  expandable input/output details.
- Basic session history persists.
- Host file and shell tools work in the user's account.
- First-run UX clearly states that v1 tool execution is unsandboxed.

### Milestone 4: Model Picker And Download UX

Exit criteria:

- User can search broad Hugging Face results filtered to GGUF models.
- llama-server download/cache errors are visible through status and logs.
- New model records update Pi `models.json` and llama `models.ini`.
- User can switch active model from UI.
- User can attach text files, PDFs, and images. Image/PDF-as-image controls are
  gated by selected-model vision support; audio/video attachments are not shown.
- Composer shows context-window usage with used/total token tooltip.

### Milestone 5: Mobile LAN API

Exit criteria:

- Server can enable LAN pairing.
- QR pairing works with a simple client or test harness.
- Paired client can send chat prompts and receive stream events.
- Paired client can submit an Expo push token.
- Server can send a test push through Expo Push Service.
- Device credentials are revocable.

### Milestone 6: Packaging

Exit criteria:

- Windows, macOS, and Linux launchers start the server and open the browser UI.
- App data paths and process cleanup work on each platform.
- Basic smoke tests run on each supported OS.

## Current Open Decisions

1. Should Pi project resources/extensions be supported at all, or should Nelle
   only use a controlled Pi runtime and Nelle-owned tools?
2. Which Linux source-build backends are v1 scope: CPU, CUDA, Vulkan, ROCm, or a
   smaller subset?
3. Which Windows/macOS release assets/backends should the UI recommend by
   default?
4. Should external access eventually be Nelle-hosted relay, user-owned tunnel,
   Tailscale-style private network, or all of the above?
5. What is the expected user profile: developers comfortable with local AI
   knobs, or nontechnical users who need aggressive defaults and fewer controls?
6. Should Hugging Face auth/gated models be first-release scope?
7. Should the server expose OpenAI-compatible endpoints for third-party local
   tools, or only the Nelle-specific API?
8. What is the minimum acceptable packaged app size?
9. Are we comfortable with GPL/other model license surfaces being shown as UI
   warnings rather than enforced policy?
