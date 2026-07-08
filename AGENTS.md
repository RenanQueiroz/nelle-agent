# AGENTS

Project-specific guidance for AI coding agents.

## Project Rules

- Keep documentation current with every repository change. Update `README.md`,
  `plans/nelle-agent-architecture.md`, and `AGENTS.md` whenever implementation
  behavior, setup commands, architecture, or workflow expectations change.
- `AGENTS.md` is the single source of truth for shared agent guidance. Root
  `CLAUDE.md` should contain only `@AGENTS.md`.
- Use a Node version matching `package.json` `engines` before running npm
  commands.
- Primary checks are `npm run format:check`, `npm run lint`, `npm run check`,
  `npm run test:unit`, `npm run build:web`, `npm run test:e2e`, and
  `npm test`.
- Formatting and linting use Oxfmt and Oxlint. Run `npm run format` for
  formatter writes and `npm run lint:fix` for safe lint fixes.
- Run Playwright e2e tests for UI behavior changes when possible. The e2e
  server uses `.nelle-e2e/` and starts on `127.0.0.1:8799`.
- Codex has a local Playwright MCP server configured in `~/.codex/config.toml`;
  restart the Codex session after MCP config changes.
- The current POC stores app data under `.nelle/` by default. Do not commit
  generated app data, e2e app data, downloaded models, llama.cpp builds, test
  reports, or logs.
- `.nelle/settings.sqlite` is generated app data. It stores conversation rows,
  active-branch projections, and Nelle-only sidecar metadata; do not commit it.
- `.nelle/backups/` contains generated SQLite migration backups; do not commit
  it.
- Hugging Face GGUF `hf-repo` refs stay exact, but llama.cpp router sections and
  OpenAI `model` ids use llama.cpp-canonical quant tags. Qwen-family models use
  Pi's `qwen-chat-template` compatibility with thinking off for normal chat.
- Generated llama.cpp presets omit `n-gpu-layers` by default. Only write GPU
  offload flags when the user explicitly configures them.
- Launch llama-server with configurable `modelsMax` and `sleepIdleSeconds`
  settings. Defaults are `1` and `90`, and changes require a server restart.
- Do not reintroduce local GGUF path registration or Nelle-owned model downloads
  in the active product; model imports are Hugging Face `hf-repo` entries.
- The web app uses React Compiler through `@vitejs/plugin-react`'s
  `reactCompilerPreset()` and `@rolldown/plugin-babel` in
  `apps/web/vite.config.ts`.
- Nelle persists managed llama-server ownership in
  `.nelle/llama/llama-server.pid.json` so restarted servers can adopt and stop
  the prior router process.
- Browser/server UI code should use Nelle's `/api/llama/*` router facade for
  llama.cpp props, models, load/unload, reload, model props, and router events.
  Do not call llama.cpp directly from the web app.
- Runtime settings should show router-reported loaded/maximum model capacity
  from `/api/llama/props`; let llama.cpp enforce model scheduling.
- `/api/llama/tokenize` proxies llama.cpp `/tokenize` for text-only estimates.
  Post-compaction context refreshes persist the estimate in
  `conversations.context_usage_json` and stream a `context.updated` event.
- Each Nelle conversation maps to one Pi session JSONL file. Treat Pi session
  files as authoritative for message history, compaction, and branch state;
  SQLite stores conversation indexes, projections, and Nelle-only sidecar
  metadata.
- Projection sync may rebuild the active SQLite view from Pi's current branch,
  but must not rewrite the Pi session file or drop inactive branches from the
  append-only JSONL history.
- Conversation snapshot reads should refresh the active projection from the
  bound Pi session file when possible. After a server restart, stale
  `running`/`compacting`/`aborting` rows without an active in-memory run should
  recover to `ready` rather than staying stuck.
- API-created conversations should immediately create and bind a header-only Pi
  session JSONL file, before the first prompt.
- On Pi-enabled startup, migrate a non-empty legacy `poc-default` chat from
  `.nelle/state.json` into a real Pi session before validating existing
  bindings. Direct llama.cpp fallback may still force-refresh the legacy
  projection for compatibility.
- Validate existing Pi session bindings before opening a runtime. Missing or
  malformed session files must mark the conversation `unavailable` and surface
  `session_unavailable`; do not create a replacement session under the same
  conversation id.
- Chat UI streaming should use `/api/conversations/:id/chat/stream`; the legacy
  `/api/chat/stream` endpoint is only a default-conversation compatibility
  wrapper.
- Implement conversation fork/duplicate through Pi
  `SessionManager.createBranchedSession()`, creating a new Nelle conversation
  for the new Pi session file, copying retained Nelle sidecar metadata, and
  leaving the source conversation unchanged.
- Browser v1 uses REST for commands/snapshots and SSE streams with typed Nelle
  event envelopes. UI stop/abort calls Pi `AgentSession.abort()`; Nelle's
  llama.cpp proxy forwards request/response close events to the upstream fetch
  `AbortSignal`.
- Chat/regenerate streams are serialized as Nelle SSE envelopes. Preserve the
  envelope reader's backward compatibility with older raw test events, and use
  stable `runId` values plus `run.started`, `message.assistant.completed`, and
  `run.completed` events when adding new stream behavior. Keep legacy `done`
  events until old clients/tests no longer need them.
- Stream `error` events must carry stable `NelleError` fields (`code`,
  `message`, optional `detail`/`retryable`/`logRef`); do not emit message-only
  errors from new server stream paths.
- `models.ini` editing should use a lossless AST parser/writer that preserves
  comments, ordering, unknown keys, and untouched user edits. Keep exact
  `hf-repo` refs while deriving stable canonical section ids for router/OpenAI
  model ids.
- `models.ini` is the active model catalog and free-form params source of
  truth. `AppStore` refreshes model records from parsed `models.ini` before
  returning model state; `.nelle/state.json` mirrors the catalog only as a POC
  compatibility backup.
- Runtime/model/global/chats controls live in the right-side Settings panel.
  Settings writes free-form string params into `models.ini` through server APIs,
  reloads router models when llama-server is running, and keeps the persisted
  stable section id as the llama.cpp/OpenAI model id.
- Model param update payloads are full replacements for editable params in a
  section. Preserve a free-form key by including it in the submitted key/value
  draft; omit it to delete it.
- The composer model selector is compact but router-aware: it is searchable,
  groups browser-local favorites first, shows selected/row router
  status/progress from router SSE updates, and loads unloaded router models
  before activating them.
- Settings rows for models with active runs must show an active-run token and
  keep unload/save/remove disabled until a terminal run event arrives.
- Browser chat run state is conversation-scoped. Use per-conversation run-kind
  state and abort controllers, keep inactive stream deltas out of the visible
  transcript, and allow a ready conversation to send while another conversation
  is still running.
- Ongoing conversations in the sidebar use an Astryx `Spinner` plus status text,
  not only a status dot, so users can spot running agents after switching chats.
- New Hugging Face imports should use the stable canonical section id as the
  model id; route clients must URL-encode model ids because they may contain
  `/` and `:`.
- Chat messages carry llama.cpp-style `performance.prompt` and
  `performance.generation` metrics. Pi calls go through Nelle's
  `/api/llama-proxy/v1` provider so streamed `prompt_progress` and `timings`
  chunks can update the UI and aborts can close the upstream llama.cpp fetch;
  `/slots` is only a best-effort fallback.
- Chat/regenerate/compact abort endpoints return `{aborted, warning?}`. When
  llama.cpp `/slots` still reports a processing slot after the grace window,
  surface the `llama_slot_still_processing` warning instead of killing
  llama.cpp automatically.
- Conversation snapshots derive last-known context usage from assistant
  performance metadata. Keep `prompt.totalTokens` as the full llama.cpp prompt
  total for context usage; `prompt.tokens` remains the processed-token count
  shown in the Reading stats widget.
- Assistant messages should persist the generating model id/runtime id and an
  alias snapshot. Footer model changes should regenerate through Pi-native
  branch replay with a model override, then group the new answer as a UI
  variant instead of overwriting the prior answer.
- The current POC exposes regeneration at
  `/api/conversations/:id/messages/:messageId/regenerate`, branches the Pi
  session before the original user entry, replays that user text, and stores
  `regenerates_pi_entry_id` / `display_group_id` sidecar metadata. The web UI
  preserves existing answer variants, hides replayed duplicate user turns, and
  labels visible assistant variants in the footer.
- The web UI conversation pane is collapsible and uses `@tanstack/react-virtual`
  for pinned/recent conversation sections. Keep row actions and e2e tests aligned
  when changing the sidebar.
- The composer slash-command allowlist currently exposes only `/compact`.
  Unsupported slash commands must be blocked client-side with composer status
  guidance and must not be sent to Pi as prompts.
- Assistant performance metadata should render as a toggleable Reading
  (prompt processing) / Generation (token output) stats widget with icon
  controls and Astryx tooltips, not as a plain text throughput string.
- Tool calls must be correlated by stable `id` / Pi `toolCallId`; stream updates
  should upsert existing calls and preserve expandable input/output detail.
- Host file/shell tools are unsandboxed in v1 and disabled until the user
  acknowledges the warning in Settings. Keep the global enable/disable switch,
  reset cached Pi sessions after changes, and persist tool audit events until
  sandboxing/per-tool permissions are designed.
- Keep the workbench viewport-bounded. Do not reintroduce document-level
  scrolling; side panels and the chat history should scroll internally while
  the composer stays docked.
- Sidebar conversation history virtualization uses `@tanstack/react-virtual`
  with an Astryx-styled `SideNav`/`List` row surface. Keep row keys stable and
  model pinned/search/group headers as one flattened virtual list.
- Composer attachments are text files, PDFs, and images only. Gate images and
  PDF-as-image mode on selected-model `modalities.vision`; do not expose
  audio/video attachments while Pi's structured input path is text plus image.
- Current attachments are request-embedded: browser drafts stay client-only,
  text/PDF files are extracted in the web app by default, PDF-as-image mode
  renders pages to PNG data URLs, images are base64-normalized and stored
  content-addressed under `.nelle/attachments/` after send, and metadata is
  bound to the resulting Pi user entry in SQLite.
- Conversation hard delete removes the deleted conversation's Pi session file
  and only unreferenced attachment files. Server startup also sweeps orphan
  files under `.nelle/attachments/` that are absent from SQLite attachment
  metadata. Keep file cleanup constrained to Nelle-owned data/session
  directories.
- Conversation export/import uses local `.nelle-chat.zip` archives with
  manifest checksums, the Pi session JSONL, Nelle sidecar metadata, referenced
  attachment files, model snapshots, and `tool-audit.jsonl` rows when host tools
  were used. Imports always create a new conversation.
- Show context-window usage through the Astryx `ChatComposer` header
  `ProgressBar` with tooltip token counts. Use composer top status for
  send-blocking errors and bottom status for non-blocking warnings.
- Do not pass arbitrary Pi slash commands through chat input. Nelle supports
  only its allowlist, initially `/compact [instructions]`; session, model, auth,
  settings, export, and copy flows belong to Nelle UI controls.
- `/compact [instructions]` is implemented with Pi `AgentSession.compact()`;
  compaction stop uses `AgentSession.abortCompaction()`. Do not send
  `/compact` through normal prompt submission.
- Let Astryx `ChatComposer` render its default `ChatSendButton` unless you are
  deliberately replacing it through `sendButton`; `sendActions` is only for
  auxiliary controls and must not create a second send affordance.
- Use `plans/nelle-router-chat-ui-plan.md` as the source of truth for the
  router-mode model lifecycle, `models.ini` ownership, sidebar, settings, and
  conversation UI overhaul.

<!-- ASTRYX:START -->
Astryx v0.1.3 · 149 components
CLI: run every command as `npx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else style/className with tokens — var(--color-*|--spacing-*|--radius-*). No raw hex/px. (No StyleX/Tailwind compiler here — don't use xstyle/utility classes.)
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   149 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
