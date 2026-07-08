# Nelle Router And Chat UI Plan

Last updated: 2026-07-08

## Goal

Move Nelle from the current proof-of-concept workbench to a router-first chat
application that uses llama.cpp's router mode as the runtime source of truth.
The target shape is closer to llama.cpp's built-in UI and ChatGPT:

1. `llama-server` always runs in router mode with `--models-preset`.
2. `.nelle/llama/models.ini` is the model catalog and parameter source of
   truth.
3. Nelle initially supports only Hugging Face GGUF references through
   `hf-repo`/`-hf`; local file paths are deferred.
4. Selecting a model can load it, show progress/status, and rely on the router
   to enforce `models-max` and unload least-recently-used models.
5. The app moves to conversation-centric chat with a collapsible sidebar,
   searchable virtualized conversation list, conversation actions, and settings.

## Upstream Findings

Snapshot inspected: `ggml-org/llama.cpp` master commit `bec4772`.

Relevant upstream behavior:

- Router mode is active when `llama-server` starts without a single model and
  uses `--models-preset <ini>`.
- `GET /props` returns router metadata when no `model` query is supplied:
  `role = "router"`, `max_instances`, and `models_autoload`.
- `GET /models` in router mode returns all known models plus status metadata.
  Each entry includes `id`, `aliases`, `source`, `can_remove`, `architecture`,
  and `status.value`.
- Router status values are `unloaded`, `loading`, `loaded`, `sleeping`, and
  `failed`.
- `POST /models/load` accepts `{ "model": "<id>", "extra_args"?: [...] }`.
  It returns before loading completes; the UI waits for `/models/sse`.
- `POST /models/unload` accepts `{ "model": "<id>" }`.
- `GET /models/sse` emits status/progress events such as `model_status`,
  `status_change`, `status_update`, `models_reload`, `model_remove`, and
  `download_progress`.
- The router backend enforces `models_max` itself. Before loading a model it
  calls `unload_lru()`, and a second locked capacity check prevents concurrent
  loads from exceeding the configured limit.
- `GET /models?reload=1` makes the router reload model sources and unload
  models whose source entry was removed or changed.
- llama.cpp also has `POST /models`, but that path validates/downloads a HF
  model into the router cache. Nelle should not use it for normal imports while
  `models.ini` is the single source of truth.

Relevant upstream UI patterns:

- On app layout mount, llama.cpp fetches router models and subscribes to
  `/models/sse` when `role = "router"`.
- The model selector displays loaded/loading state, search, favorites, and load
  progress. If a selected model is not loaded, it calls `loadModel`.
- The selector and store do not implement custom `models_max` policy; the
  backend router does.
- Assistant messages persist the model that generated them and display that
  model in the assistant footer.
- llama.cpp's assistant footer uses the router model selector as a per-message
  regenerate control. Choosing a different model loads it if needed and calls
  regenerate with a `modelOverride`.
- llama.cpp displays performance metrics through a compact statistics widget
  with icon-only view toggles for `Reading` and `Generation`, plus icon/value
  metric badges with tooltips.
- Regeneration is branch-based in llama.cpp: it creates a sibling assistant
  message from the same parent user message rather than overwriting the old
  answer. Nelle uses this as a UI reference, but intentionally maps
  regeneration to Pi-native branch replay so Pi remains the session source of
  truth.
- Copy is implemented as a message action that formats the message and writes it
  to the clipboard.
- The sidebar supports collapse/expand, new chat, settings, search, pinned
  conversations, recent conversations, per-item overflow actions, and running
  generation indicators.
- Conversation item actions include pin/unpin, edit name, export, delete, and
  stop generation when that conversation is streaming.
- In router mode, llama.cpp UI treats global `/props` as server/router metadata
  and fetches `/props?model=<id>&autoload=false` for loaded model-specific
  metadata such as modalities and `default_generation_settings.n_ctx`.
- Model modalities are exposed as booleans for `vision`, `audio`, and `video`.
  Nelle will use `vision` for image gating and ignore audio/video in the first
  attachment pass because Pi's supported structured input path is text plus
  images.
- Text files and PDFs are always accepted. PDFs are sent as extracted text by
  default, or as page images only when the selected model has vision support and
  the user enables that mode.
- Images require vision support. Unknown or binary-looking files should be
  rejected or skipped with a visible composer status.
- llama.cpp's chat stream supports `return_progress`; streamed
  `prompt_progress` contains `total`, `cache`, `processed`, and `time_ms`.
  Final/streamed `timings` carries prompt and generated-token timing data.
- llama.cpp reports context-overflow errors with `n_prompt_tokens` and `n_ctx`,
  and exposes `n_ctx` in `/props` and `/slots`.

Relevant Pi slash-command behavior:

- Pi's interactive editor opens command completion when the user types `/`.
  Built-in commands include model/session/auth/settings/history utilities plus
  `/compact [prompt]`.
- Pi also exposes extension commands, skill commands, and prompt-template
  commands through the same slash-command namespace.
- Manual compaction is the only Pi built-in slash command Nelle should support
  directly in the chat composer at first. It is conversation scoped and accepts
  optional custom instructions.
- Pi auto-compaction triggers when context exceeds its configured threshold, and
  manual `/compact [instructions]` summarizes older messages while preserving
  recent context.
- Pi `AgentSession` exposes `compact(customInstructions?)` and
  `abortCompaction()`. Nelle should implement `/compact [instructions]` by
  calling those methods directly, not by sending `/compact` through
  `session.prompt()`.
- Astryx's `ChatComposerInputSlashCommands` template uses
  `ChatComposerInput` `triggers`, `createStaticSource`, and `TypeaheadItem` to
  provide a slash-command typeahead. Nelle should reuse that pattern with its
  own command allowlist and descriptions.

Relevant Pi SDK/session behavior:

- `AgentSession` owns prompt execution, message history, model state,
  compaction, event streaming, and aborts. It exposes `prompt()`, `compact()`,
  `abort()`, `abortCompaction()`, `abortRetry()`, `sessionFile`, `sessionId`,
  `messages`, `isStreaming`, and session events.
- `AgentSessionRuntime` owns session replacement flows such as `newSession()`,
  `switchSession()`, `fork()`, clone-style fork-at-position, and import. When a
  runtime replaces its session, event subscriptions are bound to the old
  `AgentSession` and must be recreated.
- `SessionManager` owns persistent JSONL session files and the session tree. It
  can create, open, list, fork, branch, append session info, build active
  context, and expose stable entry ids plus the current leaf id.
- Nelle uses `SessionManager.createBranchedSession()` for fork/duplicate because
  it creates the required new Pi session file without replacing the source
  conversation runtime.
- Pi RPC mode exposes the same important controls if the SDK path becomes too
  coupled: `abort`, `new_session`, `switch_session`, `fork`, `clone`,
  `get_entries`, and `get_tree`.
- Because Nelle routes Pi model calls through its llama.cpp proxy, abort support
  must preserve the abort signal across the browser request, Nelle server,
  Pi/provider call, proxy fetch, and llama.cpp HTTP stream.

## Current Gaps

Nelle currently differs from the target in these ways:

- Done: `models.ini` is the model catalog and free-form global/model parameter
  source of truth. The POC `state.json` mirrors parsed model records and active
  model id only as a compatibility backup.
- New Hugging Face imports use stable canonical section ids, and Settings can
  edit aliases plus free-form global/model `models.ini` params. Direct
  full-file `models.ini` editing is not exposed.
- Runtime settings for `modelsMax` and `sleepIdleSeconds` exist, the
  Nelle-owned `/api/llama/*` router facade exists, and Settings exposes router
  status plus reload/load/unload actions. The composer control is now a compact
  searchable router-aware selector that groups browser-local favorites first,
  displays selected/row router status and progress, and loads an unloaded model
  before activation. The web app subscribes to Nelle's router SSE bridge for
  live status/progress, while bounded load actions still poll for completion.
- The web UI uses an Astryx `SideNav` shell with a collapsible, virtualized
  conversation sidebar with search, pinned/recent groups, new-chat, running
  indicators, and row actions.
  Runtime/model/global/chats controls live in a right-side Settings panel.
- The server now exposes conversation snapshots and
  `/api/conversations/:id/chat/stream`. Each streamed conversation is bound to
  one Pi JSONL session file under `.nelle/pi/sessions`, and existing session
  files are reopened on demand after a Nelle server restart.
- SQLite stores conversation rows and active-branch projections. Runtime setup
  state still lives in `.nelle/state.json`, while model catalog state is sourced
  from `models.ini` and mirrored into state for compatibility. The default
  `poc-default` chat remains for legacy compatibility.
- Basic stop now calls the run-specific abort endpoint when a stream has
  received a run id, cancels the active browser stream, and invokes Pi
  `AgentSession.abort()` for a cached conversation runtime. Chat/regenerate
  streams now emit SSE envelopes with stable run ids and terminal
  `run.completed` events, `message.assistant.completed` final assistant events,
  first-turn title generation emits `title` run events, and `run.aborted` clears
  UI run tracking/model locks. Manual compaction now streams `compact` run
  lifecycle plus command-status events and persists a post-compaction
  `/api/llama/tokenize` context estimate. Abort endpoints now run a best-effort
  llama.cpp `/slots` grace check and surface a `llama_slot_still_processing`
  warning when the slot remains active.
- Done in the current sidebar: reset/delete/pin/rename actions moved out of the
  composer footer and into each conversation row's action menu, and large lists
  use TanStack virtualization inside an Astryx `SideNav` shell.
  Fork/duplicate actions are implemented.
- Done: model import/edit UX lives in Settings and writes `models.ini`
  directly. Server reads refresh the model catalog from parsed `models.ini`
  before returning model state.
- Done: the composer has an attachment drawer, file picker, paste/drop handling,
  SQLite metadata persistence, content-addressed image storage under
  `.nelle/attachments/`, and selected-model vision gating for images. Text files
  and PDFs are sent as extracted text by default; vision-capable models expose
  PDF-as-image mode that renders pages as image attachments. Direct hard-delete
  cleanup and startup orphan attachment sweeps are implemented. Local archive
  export/import is implemented.
- Chat send-blocking errors and warnings now use composer-local Astryx status
  for the chat workflow. Runtime/setup notices outside chat can still appear in
  the page-level workbench notices.
- The composer recognizes `/compact [instructions]` through Astryx slash-command
  typeahead, routes it to Nelle's compaction API instead of normal prompt
  submission, blocks unsupported Pi slash commands, and renders local
  compaction status rows.

## Target Data Ownership

### `models.ini`

`models.ini` becomes the durable model catalog. Nelle should parse, edit, and
write this file through structured INI operations.

Minimum shape:

```ini
version = 1

[*]
c = 8192

[unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL]
hf-repo = unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL
alias = Qwen 35B Q4 XL
stop-timeout = 10
```

Rules:

- Only HF-backed model sections are supported in this phase.
- Every user-imported model section must include `hf-repo`.
- `alias` is the user-facing display label in Nelle's model dropdown.
- Section names stay llama.cpp/OpenAI model ids. They should be stable and
  compatible with llama.cpp canonicalization.
- The `[*]` section stores global llama.cpp parameters.
- Model sections store per-model overrides.
- Nelle should avoid silently writing flags not configured by the user.
- Preserve unknown keys so advanced users can keep manually edited options.
- The UI should expose key/value editing for global and per-model params, with
  lightweight validation for duplicate keys, empty keys, and dangerous section
  names.

Round-trip strategy:

- Implement a small lossless INI AST parser/writer for `models.ini` instead of
  formatting from an object map. Node types should include blank lines,
  comments, pre-section key/value lines, section headers, section key/value
  lines, and malformed lines.
- Preserve order, comments, unknown keys, and raw values for sections Nelle does
  not touch.
- Treat the last duplicate key in a section as the effective value for reads,
  matching common INI behavior, but block UI saves for a section that contains
  duplicate editable keys until the user resolves them.
- Update existing managed keys in place when possible. Append new keys to the
  target section. Append new model sections at the end of the file.
- Do not normalize user-entered values beyond trimming key names and removing
  newline characters. Values remain strings because llama.cpp owns flag parsing.
- Use atomic writes: write to a temp file in the same directory, fsync when
  practical, then rename over `models.ini`. Keep the previous file as
  `models.ini.bak` before the rename so failed user edits can be manually
  recovered.
- Validate before write: no empty section names, no section names containing
  `[`/`]`/newlines, no empty keys, no key names containing `=` or newlines, and
  no duplicate section names in the effective model catalog.
- If router reload/start fails after a write, do not silently roll back. Surface
  the error and llama-server logs; the free-form params are intentionally
  user-owned.

Model id canonicalization:

- Store the exact Hugging Face selection in `hf-repo`, including any upstream
  quant tag such as `UD-Q4_K_XL`.
- Derive the initial llama.cpp/OpenAI section id from
  `<repoId>:<canonicalQuantTag>`.
- `canonicalQuantTag` comes from HF GGUF metadata when available. Otherwise it
  is derived from the selected GGUF filename/group by removing file extensions,
  shard suffixes, and a leading `UD-` prefix while preserving the remaining
  case. Example: `UD-Q4_K_XL` becomes `Q4_K_XL`.
- If two imported HF refs would produce the same section id, append a stable
  short hash of the exact `hf-repo` ref to the section id rather than
  overwriting.
- Do not automatically rename an existing section after router load. Keep the
  section id stable for Pi sessions and user edits, and store any router-reported
  `id` as `router_model_id` in Nelle's SQLite model cache.
- For load/unload and chat requests, prefer the configured section id. If the
  router reports a different runtime id in `/models` or the chat stream, persist
  it on generated assistant metadata as `model_runtime_id`.
- Register Pi models from the same stable section ids so old sessions remain
  replayable even if the router later reports a more specific runtime id.

### App Database

Move durable app state to SQLite before, or as part of, the sidebar work. Pi
session files remain the source of truth for conversation message history and
branching; SQLite stores Nelle's conversation index, UI state, projections, and
sidecar metadata.

One Nelle conversation maps to exactly one Pi session JSONL file.

Pi-owned:

- Message history.
- Current active leaf and branch tree.
- Compaction entries and branch summaries.
- Model/thinking changes stored by Pi.
- Session display name via `SessionInfoEntry` when Nelle renames or generates a
  title.

Nelle-owned:

- Conversation id, pinning, deletion, search index, and app-specific timestamps.
- Mapping from Nelle conversation id to Pi `sessionFile` and `sessionId`.
- Model alias snapshots, llama.cpp runtime ids, and performance metadata not
  persisted by Pi.
- Attachment binary storage and browser-side attachment processing metadata.
- Router/runtime status and UI preferences.

Runtime lifecycle:

- Create new conversations with `SessionManager.create(cwd, sessionDir)`, using
  Nelle's app-owned Pi session directory under `.nelle/pi/sessions`.
- Reopen existing conversations with
  `SessionManager.open(pi_session_path, sessionDir)`.
- Maintain a lazy `PiConversationRuntimePool` keyed by `conversation.id`.
  Dispose idle runtimes after a configurable idle window, but keep the session
  files durable.
- Allow multiple conversation runtimes to be active at once when Pi supports it.
  Nelle enforces one active run per conversation, while different conversations
  may stream concurrently. llama.cpp/router capacity still determines actual
  model execution.
- After a Nelle server restart, rebuild the runtime pool lazily from SQLite
  conversation rows and Pi session files. Resync projections by reading Pi
  entries after `last_synced_pi_entry_id`.
- If a Pi session file is missing or corrupt, mark the conversation unavailable
  and show a repair/delete/export-diagnostics action instead of creating a new
  unrelated session under the same Nelle conversation id.
- Forking or duplicating a conversation creates a new Pi session file through
  Pi's `SessionManager.createBranchedSession(leafId)` primitive and then
  creates a new Nelle conversation row that points to that new file. Use
  `SessionManager.open()` directly for this file-level operation so the source
  conversation's live runtime and active stream are not replaced.
- Hard-deleting a conversation deletes its SQLite rows, Pi session file, and
  attachment files.

Core tables:

- `conversations`: `id`, `title`, `title_source` (`generated`, `user`,
  `imported`, `fallback`), `pinned`, `pi_session_path`, `pi_session_id`,
  `active_leaf_pi_entry_id`, `last_synced_pi_entry_id`, `default_model_id`,
  `parent_conversation_id?`, `forked_from_pi_entry_id?`, `fork_kind?`
  (`fork`, `clone`), `status`, `created_at`, `updated_at`, `deleted_at?`.
- `conversation_entry_projection`: `conversation_id`, `pi_entry_id`,
  `parent_pi_entry_id`, `entry_type`, `role?`, `text_preview?`, `created_at`,
  `model_id?`, `model_runtime_id?`, `model_alias_snapshot?`,
  `performance_json?`, `tool_calls_json?`, `attachment_summary_json?`,
  `regenerates_pi_entry_id?`, `display_group_id?`.
- `message_attachments`: `id`, `conversation_id`, `pi_entry_id?`, `upload_id?`,
  `kind`, `name`, `mime_type`, `size_bytes`, `storage_path?`, `text_content?`,
  `processing_json`, `created_at`.
- `model_cache`: `section_id`, `hf_repo`, `alias`, `router_model_id?`,
  `status?`, `modalities_json?`, `context_window?`, `updated_at`.
- `tool_audit_events`: `id`, `conversation_id`, `pi_entry_id?`,
  `pi_tool_call_id`, `tool_name`, `status`, `input_json`, `output_json?`,
  `error_json?`, `started_at`, `completed_at?`, `duration_ms?`.
- `schema_migrations`: `version`, `name`, `applied_at`, `checksum`.
- `settings`: runtime and UI settings that are not model params.

Recommended indexes:

- `conversations(pinned DESC, updated_at DESC)`.
- `conversations(status, updated_at DESC)`.
- `conversations(pi_session_id)` unique when non-null.
- `conversations(pi_session_path)` unique.
- FTS5 table for conversation title/search text, fed from `conversations.title`
  and optionally projected message previews later.
- `conversation_entry_projection(conversation_id, pi_entry_id)` primary key.
- `conversation_entry_projection(conversation_id, parent_pi_entry_id)`.
- `conversation_entry_projection(conversation_id, created_at)`.
- `conversation_entry_projection(conversation_id, display_group_id)`.
- `message_attachments(conversation_id, pi_entry_id)`.
- `model_cache(section_id)` primary key.
- `tool_audit_events(conversation_id, started_at)`.
- `tool_audit_events(conversation_id, pi_tool_call_id)`.

Projection rules:

- The Pi session JSONL file is authoritative. Projection rows are cache rows and
  may be rebuilt from Pi entries plus Nelle sidecar metadata.
- Use Pi `entry.id` as the durable cursor for streaming, resume, branch
  grouping, and projection sync.
- Cache `active_leaf_pi_entry_id` from `SessionManager.getLeafId()` after each
  operation.
- Do not model `active_child_id` in SQLite. Active path and branch selection
  come from Pi's current leaf.
- Store Nelle-only performance/tool UI metadata against the Pi assistant entry
  id as soon as the final Pi entry id is known. During streaming, use a
  temporary `runId`/`temporaryMessageId` and reconcile on completion.

Message model metadata:

- `model_id` is Nelle's configured model/section id used to request the answer.
- `model_runtime_id` is the llama.cpp/OpenAI model id observed in the request or
  stream, such as the canonical quant-tag id.
- `model_alias_snapshot` is the display label at generation time. It keeps old
  messages understandable even if the user later renames or removes the model.
- For Pi responses, set these fields from the active/override model at stream
  start and update from llama.cpp stream metadata if the proxy observes a more
  specific runtime id.

Keep generated files out of the DB:

- `.nelle/llama/models.ini`
- `.nelle/llama/llama-server.pid.json`
- Pi session JSONL files under `.nelle/pi/sessions`
- logs, downloads, llama.cpp binaries/builds
- attachment binary payloads under `.nelle/attachments/` when they are too
  large or unsuitable for SQLite rows

## Router Runtime Architecture

### Launch

Always launch router mode:

```bash
llama-server \
  --host <host> \
  --port <port> \
  --models-preset <data-dir>/llama/models.ini \
  --models-max <configured max> \
  --sleep-idle-seconds <configured seconds>
```

Changes from current behavior:

- Remove the requirement for an active model before start. The router can start
  with zero or many model sections.
- Stop writing a one-model preset during start.
- Stop forcing `--models-max 1`. Store `modelsMax` as a user setting and pass it
  through. Default remains `1`.
- Pass `--sleep-idle-seconds` from user settings. Default is `90`.
- Changing `modelsMax` or `sleepIdleSeconds` requires a `llama-server` restart.
- Keep managed pid adoption logic.

### Runtime API Facade

Nelle should expose stable local APIs that wrap llama.cpp router endpoints:

- `GET /api/llama/props`
  - calls router `/props`
  - returns `role`, `maxInstances`, `modelsAutoload`, runtime status
- `GET /api/llama/models/:id/props`
  - calls router `/props?model=<id>&autoload=false`
  - returns model-specific `modalities`, `n_ctx`, chat template, and fetch state
  - may return `unavailable` for unloaded models without autoloading them
- `GET /api/llama/models`
  - calls router `/models`
  - merges model metadata with parsed `models.ini` display aliases and params
- `POST /api/llama/models/:id/load`
  - calls router `/models/load`
  - returns immediately plus current status
- `POST /api/llama/models/:id/unload`
  - calls router `/models/unload`
- `GET /api/llama/models/events`
  - server-sent event bridge for router `/models/sse`
- `POST /api/llama/models/reload`
  - calls router `GET /models?reload=1`
- `PUT /api/llama/models-ini`
  - writes global and model-section params, then reloads if running
- `POST /api/llama/tokenize`
  - done: proxies llama.cpp `/tokenize` and returns a normalized token count
  - used for text-only draft/context estimates and post-compaction context
    refreshes when exact Pi/llama compaction metrics are unavailable
  - estimates are marked with `source: "estimate"` and should not be presented
    as exact multimodal/chat-template/tool-history counts

Nelle's UI should not call llama.cpp directly except through the existing chat
proxy path. This gives us one place to normalize errors, router-offline states,
and future auth/pairing.

### Model Loading

Selection behavior:

1. User selects a model by section id/model id.
2. If router reports `loaded` or `sleeping`, use it immediately.
3. If router reports `unloaded`, call Nelle load API.
4. Subscribe to model SSE status and show progress until `loaded`.
5. Fetch `/api/llama/models/:id/props` once loaded so the UI can cache
   modalities and context size for that model.
6. If loading fails, keep the previous selection and surface the router status
   and logs link.

Capacity behavior:

- Let llama.cpp enforce `models-max`.
- Do not try to pre-unload models in the UI.
- When `models-max` is reached, router `load()` attempts LRU unloading. If the
  locked capacity check still fails, surface the error and refresh model status.
- Display current `max_instances` from `/props` so users understand why a model
  was unloaded.

Router and model race handling:

- A run captures its `requestedModelId` at start. Changing the composer model
  after a run starts affects only the next send.
- Assistant footer regeneration captures its override model at action time. If
  the override model is unloaded, load it first and start regeneration only
  after the router reports `loaded` or `sleeping`.
- If a model is unloaded by router LRU while selected in the composer, keep it
  selected and mark it `unloaded`; the next send can load it again.
- If a model is removed from `models.ini` while selected, clear the active
  composer selection and show a top composer error until the user chooses a
  configured model. Historical assistant messages keep their alias snapshot and
  runtime id.
- If a model section is edited while the router is running, write `models.ini`
  first, call router reload, then refresh `/models`. Warn that editing a loaded
  model can unload/reload it and should not be done during active runs.
- Disable destructive model edits while any active run is using that model. For
  non-destructive alias edits, allow the save and keep existing assistant
  `model_alias_snapshot` values unchanged.
- If router reload reports that a loaded model source was changed or removed,
  treat the affected status update as authoritative and update selectors,
  settings rows, and composer status from the next `/models` refresh.
- If the router reports a runtime id different from Nelle's section id, store it
  in `model_cache.router_model_id` and assistant `model_runtime_id`, but keep
  Nelle requests and Pi model registry entries keyed by the stable section id.
- If model loading fails during send/regenerate, do not append a user message
  or move Pi's active leaf. Surface the router error and logs link.

## Model Management UX

Move model import and editing into Settings.

Settings sections:

- Runtime
  - install/update llama.cpp
  - start/stop router
  - host/port
  - `models-max`
  - `sleep-idle-seconds`
  - easy access to llama-server logs/status
- Models
  - search Hugging Face GGUF repos/quants
  - import selected HF ref into `models.ini`
  - edit display alias
  - edit model-section key/value params
  - duplicate/remove model sections
  - load/unload actions with live status
- Global llama.cpp params
  - edit `[*]` key/value params
- Chats
  - clear all chats
  - export/import conversations

HF import:

1. Search HF for GGUF repos and quants as today.
2. User selects repo and quant.
3. Nelle adds/updates a section in `models.ini`:
   - section id: the stable `<repoId>:<canonicalQuantTag>` id from the Model id
     canonicalization rules, with a short hash suffix on exact-ref collision
   - `hf-repo = <repo>:<quant>`
   - `alias = <user alias or repo:quant>`
4. If router is running, call reload.
5. The model appears in the selector as unloaded until the user selects/load it.

Local file path support:

- Remove UI and API for local GGUF path registration immediately.
- Keep the plan open for later local-file support by representing it as a future
  `model = <path>` or other llama.cpp preset key in `models.ini`, not as direct
  Nelle-owned model downloads.

## Chat And Conversation UX

### Layout

Target first screen:

- Collapsible left sidebar.
- Main chat area with message history and docked composer.
- Model selector in the composer/header showing alias plus router status.
- Settings opens as a route or modal panel, not as always-visible side columns.

Sidebar:

- Top actions: new chat, search, settings, collapse/expand.
- Search bar filters conversations by title.
- Virtualized conversation list.
- Pinned group first, then recent/search results.
- Each item shows title, active state, optional streaming indicator, and overflow
  menu.

Conversation item menu:

- Pin/unpin.
- Rename.
- Export.
- Duplicate active branch.
- Delete.

Message/conversation branch actions:

- User message footer action: fork from this message into a new Nelle
  conversation.
- Conversation item menu: duplicate the active branch into a new Nelle
  conversation.
- Both actions use Pi's built-in session branching file logic and create a new
  Pi session file plus a new Nelle conversation row. The source conversation is
  not mutated.

Composer:

- Remove reset conversation button from composer footer.
- Keep model dropdown.
- Keep exactly one Astryx default send/stop button.
- Add a paperclip attachment action in `headerActions`.
- Show context-window usage in `headerContext`.
- Add slash-command typeahead for Nelle-supported chat commands.
- Route chat-blocking errors and chat warnings through Astryx `ChatComposer`
  status instead of page-level notices.

### Composer Attachments, Context, And Status

Use Astryx's full-featured composer pattern:

- `ChatComposerDrawer` holds attachment chips/previews.
- `Token` represents attached files with remove controls.
- `headerActions` contains the attach-file button and later any context-source
  controls.
- `headerContext` contains a compact `ProgressBar` for context-window usage.
- `footerActions` keeps the router-aware model selector and settings controls.
- `sendActions` remains for auxiliary controls only. Do not add another send
  button.

Attachment support:

- Start with user-selected local files from the browser file picker, drag/drop,
  and paste when browser APIs support it.
- Supported attachment kinds are text files, PDFs, and images. Audio and video
  attachments are out of scope for this phase.
- Voice capture remains out of scope.
- Use browser-side file processing for preview and immediate send:
  - read text files as UTF-8 and reject empty/binary-looking content;
  - extract PDF text with `pdfjs-dist`;
  - optionally render PDF pages to PNG data URLs when the selected model has
    vision support and the user enables PDF-as-image mode;
  - normalize image formats to model-friendly data URLs where needed.
- Persist attachment metadata with the message. Store large binary payloads
  under `.nelle/attachments/` and keep the DB row as metadata plus relative
  storage pointer.

Attachment storage and limits:

- Use content-addressed storage under `.nelle/attachments/<sha256-prefix>/`
  for raw binaries that must be retained, with original filenames stored only as
  metadata.
- Store extracted text in SQLite only when it is below `attachmentTextInlineMax`
  (recommended default: 256 KiB). Larger extracted text should be stored as a
  sidecar file with a relative path in `message_attachments.storage_path`.
- Enforce conservative first-pass limits:
  - 20 attachment items per draft message. Rendered PDF pages count as
    attachment items.
  - 25 MiB per file.
  - 100 MiB total pending attachment payload per draft message.
  - 200,000 extracted characters per text/PDF attachment before truncation with
    a visible warning.
  - 20 rendered PDF pages when PDF-as-image mode is enabled.
- Keep the limits in Nelle settings so they can become advanced controls later,
  but do not expose them in the first UI pass unless needed.
- Reject path traversal and never trust browser-supplied paths. Persist only
  normalized metadata, content hashes, and Nelle-owned relative storage paths.
- Unsent browser drafts are client-only today. Server startup sweeps
  content-addressed files under `.nelle/attachments/` that are not referenced by
  `message_attachments.storage_path`; any future server temp-upload API must add
  startup and periodic retention cleanup.
- Hard-deleting a conversation deletes attachment metadata and any attachment
  files no longer referenced by another conversation/import.
- Export/import must preserve attachment metadata and files without allowing
  archive paths to escape the import directory.

Modality gating:

- Source of truth is model-specific props from
  `/api/llama/models/:id/props`, which wraps
  `/props?model=<id>&autoload=false`.
- In router mode, unloaded models may not have props. After selection loads the
  model, refresh props before enabling model-specific attachment controls.
- If modalities are unknown, allow only text and PDF-as-text; keep image
  controls disabled with a tooltip/status explaining that the selected model
  needs to be loaded before capabilities are known.
- Text files and PDF-as-text are model-agnostic.
- Images and PDF-as-image require `modalities.vision`.
- Keep `modalities.audio` and `modalities.video` in the internal model-props
  type for parity with llama.cpp responses, but do not expose audio/video upload
  in the Nelle composer while Pi only supports text and image structured input.
- If the user switches models with pending attachments, revalidate the pending
  attachment list against the new model and surface any newly unsupported items
  as a top composer error until removed or converted.
- When replaying conversation history for a model without vision, strip
  unsupported image parts from history and surface a warning rather than sending
  invalid content.

Pi and llama.cpp payload mapping:

- Change the Nelle chat request model from `prompt: string` to
  `{ message, attachments }`, where attachments carry extracted text/PDF content
  or normalized image data. Keep unsent drafts browser-local until submit.
- For llama.cpp/OpenAI chat completions:
  - text/PDF content becomes `type: "text"` content parts;
  - images/PDF pages become `type: "image_url"` parts.
- For Pi:
  - advertise `input: ["text", "image"]` in the generated Pi model registry so
    valid image prompts can pass through Pi. Nelle's router-props gate is the
    authoritative per-model vision check until model capability caching is
    implemented;
  - send text plus image content through Pi's structured user-message path:
    text/PDF attachments are appended as explicit text attachment blocks, while
    images are passed through `AgentSession.prompt(text, { images })`.
- If Pi cannot handle the selected structured content path, the composer should
  show a top error. Do not silently drop attachments or fall back to plain text.

Context-window display:

- Show an Astryx `ProgressBar` in the composer `headerContext`.
- The progress bar total is selected-model `n_ctx` from
  `/api/llama/models/:id/props`, falling back to global `/props` only outside
  router mode.
- Authoritative used-token values come from streamed `prompt_progress.total`
  during prompt processing and final/streamed `timings.prompt_n` plus cache and
  generated-token counters when available.
- The bar should update live during prompt processing and generation, then keep
  the last known usage for the active conversation.
- A debounced text-only `/api/llama/tokenize` estimate may be used for draft
  text/PDF content, but it must be marked internally as estimated and replaced
  by streamed llama.cpp values as soon as they arrive.
- The visible UI is just the progress bar. Wrap it in Astryx `Tooltip` with
  exact numbers when available, e.g. `Context: 6,240 / 32,768 tokens`.
- Use semantic progress variants:
  - neutral/accent below 80%;
  - warning at or above 80%;
  - error at or above 100% or when llama.cpp returns context overflow.
- Near-full context warnings should render as bottom composer status.
- Context overflow and send-blocking errors should render as top composer
  status.

Composer status routing:

- Use `ChatComposer` `statusPosition="top"` for blocking errors:
  llama-server stopped, no model selected, model load failed, unsupported
  attachment, attachment parse failure that prevents sending, context overflow,
  and Pi/provider structured-content gaps.
- Use default bottom status for non-blocking warnings: context near full,
  PDF-as-image disabled/fallback to text, image history stripped after model
  switch, skipped empty text files, and partial attachment conversion fallback.
- General runtime/setup notices outside the chat workflow may still appear in
  settings/log surfaces, but chat sendability should be explained at the
  composer itself.

### Slash Commands And Manual Compaction

Nelle should not pass arbitrary Pi slash commands through the chat input. The
chat composer owns a Nelle allowlist and should intercept slash commands before
normal prompt submission.

Supported initially:

- `/compact [instructions]`: manually compact the active conversation/Pi
  session. Optional instructions should focus the generated summary and should
  be visible in the command-status details.

UI-owned or unsupported initially:

- `/new`: use the sidebar new-chat button.
- `/resume`: use the conversation sidebar and search.
- `/model` and `/scoped-models`: use Nelle's router-aware model selectors.
- `/login` and `/logout`: use future Settings auth/provider flows. Nelle's
  local llama.cpp provider remains app-managed.
- `/settings`: use Nelle Settings.
- `/fork` and `/clone`: use Nelle's message/conversation menus, backed by Pi
  `SessionManager.createBranchedSession()` session-file branching.
- `/name`, `/session`, `/tree`, `/export`, `/import`, and `/share`: use
  Nelle's conversation sidebar, branching, export/import, and sharing flows as
  those features are implemented.
- `/copy`: use the assistant message copy button.
- `/trust`, `/reload`, `/hotkeys`, `/changelog`, and `/quit`: keep out of the
  chat composer unless Nelle implements explicit equivalents later.
- Pi extension commands, skill commands, and prompt-template commands: disabled
  or hidden by default until Nelle has a per-command allowlist and security
  model. They share the same namespace and can bypass the product boundaries we
  are building in the web UI.

Slash-command UI:

- Use the Astryx `ChatComposerInput` trigger pattern from
  `ChatComposerInputSlashCommands`: `character: "/"`, a static/searchable
  command source, `TypeaheadItem` descriptions, and token insertion through
  `onSelect`.
- Autocomplete should show only commands Nelle supports now. For the first
  implementation that means `/compact`.
- Add a command help surface, likely available from the typeahead empty state or
  a settings/help link, that explains unsupported Pi commands and the Nelle UI
  control that replaces each one.
- If a user manually submits an unsupported slash command, do not send it to
  Pi. Show a top composer error with the Nelle-owned alternative, such as "Use
  the model selector to change models."
- If the user submits an unknown slash command, show a top composer error and
  keep the draft in the composer.

`/compact` behavior:

1. Parse `/compact` and optional trailing instructions client-side or
   server-side before normal chat submission.
2. Require the active conversation to be idle for the first implementation.
   Reject while an assistant turn or another compaction is running and surface a
   composer top error.
3. Call a conversation-scoped Nelle stream endpoint:
   `POST /api/conversations/:id/compact/stream`. Keep
   `POST /api/conversations/:id/compact` as a compatibility JSON endpoint for
   non-streaming callers.
4. The server invokes `AgentSession.compact(instructions)` for the active
   conversation/session.
5. Render a command/status row in the chat timeline with states such as
   pending, compacting, completed, and failed. This row should not be stored as
   a normal user or assistant message.
6. On completion, refresh context-window usage and conversation/session
   metadata. If Pi exposes compaction details such as tokens before, first kept
   entry, or summary metadata, store them in the command row details.
7. On failure, keep conversation history unchanged and show both the failed
   status row and a composer top error.

Abort behavior:

- If the user stops an active compaction run, call
  `AgentSession.abortCompaction()` for that conversation runtime and emit the
  normal aborted run events.
- Do not send `/compact` through `AgentSession.prompt()` and do not persist it
  as a normal user message.

### Tool Permission And Audit UX

Host file/shell tools are v1 scope, but they are not sandboxed in the first
implementation. Nelle should make that tradeoff explicit and auditable.

First-run and settings policy:

- Show a first-run acknowledgement before enabling host file/shell tools. The
  text should state that tools run with the same OS permissions as the user who
  launched Nelle. Done: Settings exposes this acknowledgement before enabling
  host tools.
- Default recommendation: enable host tools only after this acknowledgement.
  The product may still ship with tools available in v1, but the user should
  make an explicit informed choice. Done: host tools default to disabled until
  acknowledged.
- Add a Settings control to enable/disable host tools globally. Disabling tools
  updates the Pi model/tool registry for new runs and blocks tool execution for
  active conversation runtimes when possible. Done: setting changes reset cached
  Pi sessions so new runs use the current tool registry.
- Do not add per-tool approval prompts in the first implementation; that is a
  later sandbox/permissions phase. The first pass focuses on clear disclosure,
  visible execution rows, and auditability.

Runtime behavior:

- Tool calls render inline as expandable chat rows correlated by Pi
  `toolCallId`.
- Expanded rows show tool name, status, normalized input, normalized output,
  duration, and error detail when present.
- Sensitive values should not be guessed or automatically redacted in v1, but
  rows should avoid adding extra secrets beyond what Pi/tool execution already
  emitted.
- If host tools are disabled, Pi sessions are created with an empty tool list
  and the system prompt states that host tools are disabled. A future stricter
  guard can add explicit `tools_disabled` stream errors if Pi ever emits a tool
  event despite an empty registry.

Audit storage:

- Persist an append-only audit trail for host tool calls under Nelle-owned app
  data. Recommended first implementation: SQLite table `tool_audit_events` plus
  optional JSONL export files under `.nelle/logs/tools/`. Done: tool starts and
  completions are persisted in `tool_audit_events`.
- Minimum fields: `id`, `conversation_id`, `pi_entry_id?`, `pi_tool_call_id`,
  `tool_name`, `status`, `input_json`, `output_json?`, `error_json?`,
  `started_at`, `completed_at?`, and `duration_ms?`.
- Audit rows are Nelle sidecar metadata. They may be exported with a
  conversation, but Pi session files remain the message-history source of truth.
  Done: `.nelle-chat.zip` includes `tool-audit.jsonl` rows for the exported
  conversation.
- Clearing all chats removes matching audit rows unless the user explicitly
  exports diagnostics first. Done: conversation reset and clear-all paths remove
  matching audit rows.

### Assistant Message Footer

Each assistant message footer should show:

- Timestamp.
- Model picker/dropdown displaying the model that generated that answer.
- Toggleable performance statistics when available.
- Copy button.
- Regenerate button.

Use Astryx `ChatMessageMetadata.footer` as a React node instead of a formatted
string. The footer should remain compact, wrap cleanly on narrow widths, and use
icon buttons with accessible labels/tooltips for copy and regenerate.

### Performance Statistics View

Replace the previous plain `prompt 32.30 tok/s · gen 21.53 tok/s` footer text
with a compact statistics widget modeled after llama.cpp's
`ChatMessageStatistics`.

Views:

- `Reading`: prompt processing.
- `Generation`: token output.

View toggles:

- Use icon-only controls rather than visible text labels.
- Use a book/read icon for `Reading (prompt processing)`.
- Use a sparkle/output icon for `Generation (token output)`.
- Each toggle must have an accessible label and Astryx `Tooltip` content.
- During live streaming, default to `Reading` while prompt processing is active,
  then switch to `Generation` once generated tokens arrive.
- Disable the `Generation` toggle while a live message has no generated tokens
  yet.

Reading metrics:

- Prompt tokens.
- Prompt processing time.
- Prompt processing speed.

Generation metrics:

- Generated tokens.
- Generation time.
- Generation speed.

Metric display:

- Use icon/value badges or compact inline items.
- Prefer lucide icons through the existing React icon stack:
  - token count: `WholeWord` or equivalent token/word icon
  - time: `Clock`
  - speed: `Gauge`
- Wrap each metric item in Astryx `Tooltip` with the exact label, such as
  `Prompt tokens`, `Prompt processing time`, `Prompt processing speed`,
  `Generated tokens`, `Generation time`, and `Generation speed`.
- Keep visible strings short, e.g. `1,024 tokens`, `1.24s`, `32.30 t/s`.
- Metric items may be clickable later for copy-to-clipboard parity with
  llama.cpp, but that is optional for the first Nelle pass.

Data mapping:

- `performance.prompt.tokens` -> prompt tokens.
- `performance.prompt.milliseconds` -> prompt processing time.
- `performance.prompt.tokensPerSecond` -> prompt processing speed.
- `performance.generation.tokens` -> generated tokens.
- `performance.generation.milliseconds` -> generation time.
- `performance.generation.tokensPerSecond` -> generation speed.
- Prefer exact streamed llama.cpp `prompt_progress` and final/streamed
  `timings` values from Nelle's llama proxy. `/slots` data remains a fallback
  and should not overwrite exact streamed timings.

Astryx implementation direction:

- Use `Tooltip` from `@astryxdesign/core/Tooltip` for hover/focus explanations.
- Use stable, fixed-size icon buttons/badges so switching between Reading and
  Generation does not shift the surrounding footer layout.
- Keep the widget inside `ChatMessageMetadata.footer` alongside the message
  model dropdown, copy, and regenerate controls.
- Avoid raw color/spacing values; use Astryx tokens or component props.

Model dropdown behavior:

1. The dropdown's current value is the message's `model_id`/`model_runtime_id`,
   displayed using `model_alias_snapshot` or the current alias from
   `models.ini`.
2. Opening the dropdown lists router models with the same loaded/loading/failed
   status used by the composer selector.
3. Selecting the same model triggers a normal regenerate.
4. Selecting a different model loads that model through the router if needed,
   then regenerates that assistant message with `modelOverride`.
5. The per-message dropdown does not change the composer/global selected model
   unless we deliberately add that behavior later.
6. If the historical model is no longer in `models.ini`, show the snapshot label
   as unavailable and keep copy/regenerate with another selected model possible.

Copy behavior:

- Copy the assistant message content as plain text/markdown text.
- Do not include tool-call internals by default; add explicit copy controls for
  tool details later if needed.
- Use the browser Clipboard API with a fallback for non-secure contexts, and
  surface success/failure through a compact notice.

Regenerate behavior:

- Add a conversation-scoped regenerate endpoint:
  `POST /api/conversations/:conversationId/messages/:messageId/regenerate`.
- Request body: `{ "modelId"?: string }`.
- The server finds the user entry that produced the target assistant answer and
  the parent entry before that user entry.
- To stay inside Pi's public session model, regeneration creates a Pi-native
  branch by moving the session leaf to the parent of the original user entry,
  then re-submitting the same user content with the selected `modelOverride`.
  This creates a new user entry plus a new assistant entry on a branch rather
  than trying to append an assistant sibling directly under the old user entry.
- The previous assistant answer is not hard-deleted. The conversation active
  leaf moves to the regenerated branch.
- Store `regenerates_pi_entry_id` and a shared `display_group_id` in Nelle's
  projection metadata so the UI can present regenerated answers as variants of
  the original prompt while Pi remains the session source of truth.
- Store model metadata, timings, and tool calls on the newly generated assistant
  projection row.
- If model loading fails, keep the old active branch and surface the router
  error/log link.

Fork and duplicate behavior:

- Fork from a user message creates a new Nelle conversation from a Pi fork of
  that user entry. The source conversation remains open and unchanged.
- Duplicate creates a new Nelle conversation from a Pi clone-style fork of the
  current active branch, defaulting to the source conversation's current leaf.
- Use Pi's session-file branching primitive for the operation:
  1. Open the source `pi_session_path`.
  2. Resolve the requested Pi entry id, or use the source
     `active_leaf_pi_entry_id`/session leaf for duplicate.
  3. Call `SessionManager.createBranchedSession(entryId)` to create a new
     session file containing the root-to-entry path.
  4. Open the new session file with `SessionManager.open()` and read its session
     id and leaf.
  5. Create a new Nelle `conversations` row with
     `parent_conversation_id`, `forked_from_pi_entry_id`, and `fork_kind`.
  6. Sync the new conversation projection from the new Pi session file.
  7. Copy Nelle sidecar metadata that Pi does not own, including model
     snapshots, performance metrics, tool-call details, attachment summaries,
     and referenced attachment metadata.
- If the source conversation is actively streaming, allow clone from the last
  durable `active_leaf_pi_entry_id` but reject fork from entries that are not yet
  persisted.
- Default titles:
  - fork: copy the source title with ` (fork)` until title generation or user
    rename changes it;
  - clone: copy the source title with ` (copy)`.
- Export/import/sharing should continue to operate on the selected Nelle
  conversation's Pi session file.

Branch/tree UX boundary:

- v1 shows the active Pi path as the main conversation timeline.
- Regenerated assistant answers are grouped as variants for the same visible
  user prompt using Nelle `display_group_id` metadata, even though Pi represents
  the replay as a new user entry on a branch.
- Fork and duplicate are exposed as explicit actions that create new Nelle
  conversations. The source conversation stays on its current active path.
- Nelle does not need a full Pi tree explorer in the first implementation. The
  data model must preserve enough metadata to add one later, but the v1 UI does
  not expose arbitrary tree navigation, branch pruning, or branch reparenting.
- Hidden/inactive Pi branches remain in the Pi session file and can be exported
  or surfaced later. They should not be silently deleted by projection sync.
- If the active branch changes after regeneration, fork, or import, update
  `active_leaf_pi_entry_id` from Pi and rebuild the active-path projection from
  Pi rather than deriving branch state from SQLite.

### Virtualized List

Use real virtualization for conversation rows once conversation count can grow.
Decision:

- Astryx v0.1.3 provides `SideNav`, `List`, chat scroll containers, and
  infinite-message loading primitives, but does not expose a clean reusable
  virtual list/listbox for arbitrary sidebar rows.
- Use Astryx for the visual shell, row styling, tokens, menus, and tooltips.
- Use `@tanstack/react-virtual` for sidebar conversation virtualization.

Constraints:

- Build one flattened row model with section rows and conversation rows instead
  of nested virtualizers.
- `useVirtualizer` should target the sidebar scroll element owned by the
  `SideNav`/sidebar content region.
- Provide stable `getItemKey` values such as `section:pinned` and
  `conversation:<conversation_id>` so search, pinning, deletion, and prepended
  rows do not reuse DOM state incorrectly.
- Start with fixed estimated row heights and measure only if row content needs
  dynamic height later.
- Use a small overscan buffer, roughly 8-12 rows, to keep wheel/trackpad
  scrolling smooth without mounting the full history.
- Keep active-conversation navigation working with `scrollToIndex` when search
  or routing activates a row outside the visible range.
- Pinned and unpinned groups should be modeled as section rows in the flattened
  list.
- Search results should virtualize too.
- Keyboard focus and overflow menus must remain stable when rows mount/unmount.
- Overflow menus and tooltips should use portal/top-layer behavior when
  available, so a menu opened from a virtual row is not clipped by the scroll
  container or unexpectedly tied to row-local layout state.

### Conversation Persistence

Conversation snapshot contract:

`GET /api/conversations/:id` returns a complete snapshot that lets the web UI
render the active conversation after initial load, server restart, or stream
disconnect. Streams patch this state, but refetching the snapshot is always the
recovery path.

Recommended shared shape:

```ts
type ConversationSnapshot = {
  conversation: {
    id: string;
    title: string;
    titleSource: 'generated' | 'user' | 'imported' | 'fallback';
    pinned: boolean;
    status: 'ready' | 'running' | 'compacting' | 'aborting' | 'unavailable';
    createdAt: string;
    updatedAt: string;
    piSessionId?: string;
    activeLeafPiEntryId?: string;
    defaultModelId?: string;
    parentConversationId?: string;
    forkedFromPiEntryId?: string;
    forkKind?: 'fork' | 'clone';
    currentRun?: {
      runId: string;
      kind: 'chat' | 'regenerate' | 'compact' | 'title';
      modelId?: string;
      startedAt: string;
      status: 'pending' | 'running' | 'aborting';
    };
  };
  entries: ConversationEntryProjection[];
  activePathEntryIds: string[];
  attachments: AttachmentMetadata[];
  context: {
    usedTokens?: number;
    totalTokens?: number;
    source?: 'estimate' | 'prompt_progress' | 'timings' | 'pi';
    updatedAt?: string;
  };
  models: {
    selectedModelId?: string;
    defaultModelId?: string;
    available: ModelListItem[];
  };
  capabilities: {
    canSend: boolean;
    canAbort: boolean;
    canCompact: boolean;
    canFork: boolean;
    canAttachImages: boolean;
    canAttachText: boolean;
  };
  errors: NelleError[];
};
```

Rules:

- `entries` contains the active visible path plus any Nelle-visible variants
  needed to render regenerate groups. It does not need to include every hidden
  Pi tree branch in v1.
- `activePathEntryIds` is derived from Pi's current leaf and is the timeline
  ordering source for the active path.
- `capabilities` is derived from conversation status, router/model state,
  selected model modalities, host-tool settings, and active run state.
- Snapshot responses should include enough model and context data to render the
  composer without an immediate second request.
- If the Pi session file is missing/corrupt, return the conversation row with
  `status: "unavailable"` and a `session_unavailable` error instead of creating
  a replacement session.

API shape:

- `GET /api/conversations?search=&cursor=&limit=`
- `POST /api/conversations`
- `GET /api/conversations/:id`
- `PATCH /api/conversations/:id`
- `DELETE /api/conversations/:id`
- `POST /api/conversations/:id/pin`
- `POST /api/conversations/:id/export`
- `POST /api/conversations/:id/fork`
- `POST /api/conversations/:id/clone`
- `DELETE /api/conversations`
- `POST /api/conversations/:id/chat/stream`
- `POST /api/conversations/:id/abort`
- `POST /api/conversations/:id/compact`
- `POST /api/conversations/:id/compact/stream`
- `POST /api/conversations/:id/compact/abort`
- `POST /api/conversations/:id/messages/:messageId/regenerate`

Chat streaming should be conversation-scoped. The stream route appends the user
message, streams assistant deltas/tool calls/timing metadata, persists the final
assistant message, records model metadata, and updates
`conversations.updated_at`.

Fork/clone API:

- `POST /api/conversations/:id/fork`
  - request: `{ "entryId": "<pi user entry id>", "title"?: string }`
  - behavior: open the source Pi session file, validate that `entryId` is a
    persisted user-message entry, call
    `SessionManager.createBranchedSession(entryId)`, create a Nelle
    conversation row for the new Pi session file, sync its projection, copy
    Nelle sidecar metadata for retained entries, and leave the source
    conversation unchanged.
- `POST /api/conversations/:id/clone`
  - request: `{ "entryId"?: "<pi entry id>", "title"?: string }`
  - behavior: duplicate the active branch through the supplied entry or current
    leaf by calling `SessionManager.createBranchedSession(entryId)`, then create
    a new Nelle conversation row for the new Pi session file and copy Nelle
    sidecar metadata for retained entries.
- Both routes return the new conversation snapshot and may optionally stream a
  `conversation.forked` event if the caller is subscribed.

Export/import format:

- Export a single Nelle conversation as a `.nelle-chat.zip` archive.
- Archive contents:
  - `manifest.json`: format version, exported-at timestamp, app version,
    conversation id/title metadata, source platform, and checksum list.
  - `pi-session.jsonl`: the Pi session file for that conversation.
  - `nelle-conversation.json`: Nelle sidecar metadata such as pin state, title
    source, model alias snapshots, performance metadata, tool-call UI metadata,
    context metadata, and active visible branch/grouping hints.
  - `attachments/`: referenced attachment files, stored by content hash.
  - `models-manifest.json`: model ids, alias snapshots, `hf-repo` refs when
    known, router runtime ids, and context/modality metadata observed at export
    time.
  - `tool-audit.jsonl`: optional host-tool audit rows for the conversation.
    Current implementation writes persisted SQLite audit rows when host tools
    were used.
- Do not include secrets, pairing tokens, app-wide settings, managed
  llama.cpp binaries, model weights, cache directories, or logs by default.
- Validate import archives before writing: reject absolute paths, `..`
  segments, duplicate critical files, unsupported format versions, and checksum
  mismatches.
- Import creates a new Nelle conversation id and copies the Pi session file into
  `.nelle/pi/sessions`; it never overwrites an existing conversation.
- Import rebuilds projection rows from the Pi session file, then overlays
  Nelle sidecar metadata by Pi entry id where possible.
- If imported models are not configured locally, keep historical assistant
  labels from snapshots and show missing models as unavailable for
  regeneration until the user imports matching `hf-repo` refs.
- Export/import are local file operations in this plan. External sharing and
  remote sync are deferred, but the archive format should avoid local-only
  absolute paths so future sharing is possible.

### Streaming And Event Contract

Use one event envelope for conversation streams, global runtime streams, and
future mobile clients.

Transport policy:

- v1 browser clients use REST for commands/snapshots and SSE for streaming
  conversation, router, runtime, log-tail, and install/build progress events.
- Do not introduce WebSocket as the default browser transport in v1 unless a
  specific bidirectional need appears that REST commands plus SSE cannot cover.
- Mobile clients can reuse the same REST/SSE contract on LAN. If a future
  mobile transport uses WebSocket for background constraints, it should carry
  the same `NelleEventEnvelope` payloads.
- Expo push notifications are separate from chat/run streaming. Push should
  notify that work changed; the app then fetches snapshots or subscribes to
  streams when reachable.
- SSE reconnects should refetch the relevant snapshot rather than relying on
  durable event replay in v1.

Envelope:

```ts
type NelleEventEnvelope<TType extends string, TData> = {
  id: string; // monotonic ULID generated by Nelle
  type: TType;
  conversationId?: string;
  runId?: string;
  createdAt: string; // ISO timestamp
  data: TData;
};
```

Conversation stream routes return SSE for browser/mobile simplicity. Event data
is the JSON envelope above; SSE `event:` should mirror `type`, and SSE `id:`
should mirror envelope `id`.

Current implementation note: chat and regenerate routes now serialize Nelle SSE
envelopes and include stable run ids plus `run.started`, `run.aborted`, and
`run.completed` data events. The browser stream reader remains backward
compatible with older raw event payloads. Final assistant messages now emit
`message.assistant.completed`; the legacy `done` event is still emitted as a
compatibility alias while older clients/tests exist.

Durability rules:

- The stream is a delivery mechanism, not the source of truth.
- Pi session files plus SQLite projections are durable.
- If a client disconnects, it should refetch the conversation snapshot and Pi
  entry projection rather than requiring event replay.
- Event ids only need to be monotonic within one Nelle server process for v1.
  Durable replay can be added later with an event-log table if mobile clients
  need it.

Core conversation events:

Run-scoped events include `runId` and `conversationId` in the envelope and event
data.

- `run.started`: `{ kind: "chat" | "regenerate" | "compact" | "title", modelId?: string }`
- `run.completed`: `{ status: "completed" | "aborted" | "failed", error?: NelleError }`
- `run.aborted`: `{ reason: "user" | "server" | "runtime" }`
- `message.user.created`: `{ piEntryId?: string, temporaryMessageId?: string, content, attachments }`
- `message.assistant.started`: `{ temporaryMessageId: string, modelId, modelAliasSnapshot }`
- `message.assistant.delta`: `{ temporaryMessageId: string, delta: string }`
- `message.assistant.completed`: `{ temporaryMessageId: string, piEntryId: string, content, stopReason, modelId, modelRuntimeId?, modelAliasSnapshot, performance? }`
- `tool_call.updated`: `{ id, piToolCallId?, messageId?, name, status, input?, output?, error? }`
- `performance.updated`: `{ messageId?: string, temporaryMessageId?: string, prompt?, generation?, source }`
- `context.updated`: `{ usedTokens, totalTokens?, source: "estimate" | "prompt_progress" | "timings" | "pi" }`
- `compact.started`: `{ instructions?: string }`
- `compact.completed`: `{ piEntryId?: string, tokensBefore?: number, firstKeptEntryId?: string, summaryPreview?: string }`
- `compact.failed`: `{ error: NelleError }`
- `conversation.updated`: `{ title?, titleSource?, activeLeafPiEntryId?, updatedAt }`
- `conversation.forked`: `{ sourceConversationId, newConversationId, sourcePiEntryId?, kind: "fork" | "clone" }`
- `error`: `NelleError`

Core llama/router events:

- `llama.runtime.updated`: `{ state, pid?, version?, host, port }`
- `llama.model.updated`: `{ sectionId, routerModelId?, status, progress?, error? }`
- `llama.logs.updated`: `{ lines, cursor }`

Pi event mapping:

- `AgentSession` prompt start or Nelle request acceptance -> `run.started`.
- User message append/entry creation -> `message.user.created`.
- Assistant message start -> `message.assistant.started`.
- Assistant visible text delta -> `message.assistant.delta`.
- Assistant reasoning/thinking deltas are ignored for normal chat while
  Qwen-family thinking is disabled. If thinking is enabled later, add a
  separate opt-in `message.assistant.thinking_delta` event and UI surface.
- Assistant final entry -> `message.assistant.completed` plus
  `conversation.updated`.
- Pi tool execution start/progress/end -> upsert `tool_call.updated` by
  `toolCallId`.
- Pi compaction start/end/failure -> `compact.started`, `compact.completed`, or
  `compact.failed`.
- Pi abort/stop result -> `run.aborted` and `run.completed` with
  `status: "aborted"`.
- Pi auto-retry start/end should update the active run status detail and may
  emit `conversation.updated`; do not append normal chat messages for retry
  bookkeeping.
- Pi `session_info_changed` or session replacement after fork/clone -> refresh
  conversation metadata, resubscribe to the new `AgentSession`, and emit
  `conversation.updated` or `conversation.forked`.
- Pi queue/backpressure updates, if exposed, should map to run status detail
  rather than creating independent user-visible messages.
- Any Pi event Nelle does not understand should be logged at debug level and
  ignored in the UI until explicitly mapped. Unknown Pi events must not break
  the stream.

Error shape:

```ts
type NelleError = {
  code: string;
  message: string;
  detail?: string;
  retryable?: boolean;
  logRef?: string;
};
```

Naming:

- Use stable machine-readable `code` values such as
  `llama_server_stopped`, `model_load_failed`, `pi_prompt_rejected`,
  `pi_run_aborted`, `unsupported_attachment`, `context_overflow`,
  `unsupported_slash_command`, and `session_unavailable`.
- User-facing text should come from `message`, not from parsing `code`.

Conversation and run state machine:

- Conversation statuses:
  - `ready`: no active foreground run, Pi session is usable. Background title
    generation may still have an active run id while the conversation remains
    `ready`.
  - `running`: chat or regenerate run is active.
  - `compacting`: manual compaction is active.
  - `aborting`: abort request accepted and Nelle is waiting for Pi/proxy idle.
  - `unavailable`: Pi session file or runtime dependency is missing/corrupt.
- Run statuses:
  - `pending`: request accepted but Pi/provider stream has not started.
  - `running`: Pi/provider stream is active.
  - `aborting`: stop requested, abort propagation in progress.
  - `completed`: run finished normally.
  - `aborted`: run stopped by user/server/runtime.
  - `failed`: run ended with an error.
- Allowed conversation transitions:
  - `ready -> running | compacting | unavailable`.
  - `running -> ready | aborting | unavailable`.
  - `compacting -> ready | aborting | unavailable`.
  - `aborting -> ready | unavailable`.
  - `unavailable -> ready` only after explicit repair/reimport succeeds.
- Active run ids are unique per conversation. A conversation may have at most
  one `pending`, `running`, or `aborting` run.
- Starting a chat/regenerate/title run while the same conversation already has
  an active run returns `conversation_busy`. Starting chat/regenerate also
  requires conversation status `ready`.
- Starting `/compact` while the conversation is not `ready` returns
  `conversation_busy`.
- Failed or aborted title-generation runs must not move the conversation out of
  `ready` once the chat run has already completed.

### Abort And Cancellation

Abort behavior:

- Done for chat/regenerate/title/compact: add stable run ids and
  `POST /api/conversations/:id/runs/:runId/abort` for active run aborts. Keep
  the older conversation abort and compact-abort endpoints as fallbacks for
  non-streaming callers.
- The server validates that the run belongs to the conversation and is still
  active. Repeated abort requests are idempotent.
- For chat/regenerate runs, call `AgentSession.abort()` on that conversation's
  Pi session and wait for Pi to become idle. For title runs, abort the
  non-persisted llama proxy request through its run controller.
- For compaction runs, call `AgentSession.abortCompaction()` and then verify the
  session is idle.
- If a Pi auto-retry delay is active, call `AgentSession.abortRetry()` before or
  after `abort()` so the UI does not resume unexpectedly.
- Because all Pi model calls go through Nelle's llama proxy, propagate abort to
  the downstream llama.cpp fetch with `AbortSignal` and close the SSE/body
  stream. Done: the proxy forwards request/response close events to the
  upstream llama.cpp fetch signal.
- When abort completes, emit `run.aborted` and `run.completed` with
  `status: "aborted"`, then refresh the conversation projection from Pi.

Queueing policy:

- First implementation rejects new normal chat sends while the same
  conversation has an active run. We will not expose Pi `steer`/`followUp` UI
  until we design it explicitly.
- Other conversations may continue streaming if they have their own Pi runtime.

llama.cpp verification and fallback:

- Done: the llama proxy forwards abort signals to upstream chat-completions
  requests, and unit coverage verifies the upstream `AbortSignal` is passed.
- Done: after chat/regenerate/compact run aborts, Nelle best-effort checks
  `/slots?model=...` when the router exposes it. If the slot continues
  processing for more than the default 5000 ms grace window, the abort response
  includes a `llama_slot_still_processing` warning. The composer surfaces that
  warning and points the user to Settings > Runtime stop/restart controls.
- Do not auto-kill llama.cpp on abort because it can affect other conversations
  and model-load state.

## Generated Conversation Titles

Requirement:

- After the model finishes the assistant response to the first user prompt in a
  conversation, send a separate title-generation prompt.
- The title prompt must not be persisted in the conversation history.
- The generated title becomes the conversation title unless the user has already
  renamed the conversation.

Proposed title prompt:

```text
Create a concise title for this conversation.
Return only the title.
Limit it to 6 words.
No quotes, punctuation suffix, markdown, or explanation.

User: <first user prompt>
Assistant: <first assistant response>
```

Implementation notes:

- Current implementation: after a successful first Pi-backed assistant response,
  Nelle calls llama.cpp through `/api/llama-proxy/v1/chat/completions`, sanitizes
  the returned title, updates the conversation only while `title_source` is
  still `fallback`, and emits `run.started`, `conversation_title`, and terminal
  `run.completed` events for the web UI list. Aborted title requests emit
  `run.aborted` plus `run.completed` with `status: "aborted"` and keep the
  conversation in `ready` status.
- Use the same active model after the first response completes.
- Use direct llama.cpp chat-completions through Nelle's llama proxy, not Pi,
  because title generation should not invoke tools or alter Pi session state.
- Set a small `max_tokens` such as 24.
- Strip quotes/newlines, cap length, and fall back to a truncated user prompt if
  title generation fails.
- Do not trigger title generation for imported conversations or conversations
  with a user-edited title.

## Migration And Backup Plan

Existing POC state may contain `.nelle/state.json` with `models[]`,
`activeModelId`, and one global `chat`.

Migration framework:

- Store schema state in SQLite with a `schema_migrations` table rather than
  relying only on `PRAGMA user_version`.
- Run migrations inside transactions when SQLite supports the whole operation.
  Filesystem side effects should be staged first, then committed by atomic
  rename after the database transaction succeeds.
- Before any migration that rewrites app data, create a timestamped backup
  directory under `.nelle/backups/<timestamp>/`.
- Back up at least: `state.json`, `llama/models.ini`, Pi session files touched
  by the migration, SQLite database files, and attachment metadata/files touched
  by the migration.
- Keep `models.ini.bak` behavior for individual model-catalog writes even after
  SQLite migrations exist.
- If migration fails, leave the backup in place, keep the original files when
  possible, and start the app in a setup/repair-safe state with a visible error
  and log reference. Do not partially create a replacement conversation for a
  failed Pi session migration.
- Migrations should be idempotent where practical. Re-running after failure
  should detect completed steps from the database and backup markers.

POC-to-SQLite migration steps:

1. Parse existing `models[]`.
2. Write HF-backed models into `models.ini` if not already present.
3. Drop local path models from active state; keep `state.json` as backup for
   manual recovery if needed.
4. Convert global `chat` into a single Pi session file plus one Nelle
   conversation row if non-empty. Use Pi `SessionManager` append APIs so the
   migrated session is a valid Pi JSONL file.
5. Preserve the selected model as the default new-chat model if its section
   exists in `models.ini`.
6. Backfill conversation entry projections from the newly created Pi session.
7. Keep `state.json` as a backup until SQLite migration is proven.

Future migration expectations:

- Never rewrite Pi session files unless Pi provides the migration operation or
  the old file is preserved in a backup.
- Rebuild projection tables from Pi session files instead of treating
  projection rows as durable history.
- Attachment GC should run after successful migrations, not before. It should
  delete only unreferenced Nelle-owned files.
- Export/import versioning should be independent from app database migration
  versioning. Import code should migrate old archive formats into the current
  internal snapshot shape.

## Implementation Phases

### Phase 0: Contracts, Persistence, And Pi Runtime Foundation

- Add shared TypeScript/Zod schemas for `NelleEventEnvelope`, `NelleError`,
  chat content parts, attachments, performance metrics, model cache records, and
  conversation snapshots.
- Add SQLite migrations for conversations, entry projections, attachments,
  model cache, tool audit events, settings, schema migrations, and FTS title
  search.
- Add the migration/backup runner and the POC `.nelle/state.json` migration
  path.
- Add `PiConversationRuntimePool`:
  create/open/dispose runtimes by conversation id, map each conversation to one
  Pi session file, resubscribe after runtime replacement, and support multiple
  active conversation runtimes.
- Add Pi session projection sync from `SessionManager` entries into SQLite,
  using Pi entry ids and leaf id as durable cursors.
- Add the Nelle SSE event envelope helper, transport policy helpers, Pi event
  mapper, and conversation/run state machine.
- Done: add the abort API and Pi/proxy abort propagation before expanding the
  UI.
- Add lossless `models.ini` parser/writer and model id canonicalizer.
- Done: add export/import archive schemas and validation helpers, including
  manifest checksum validation and safe-path checks.

Exit criteria:

- Creating a conversation creates a Pi session file and stores its path/id in
  SQLite.
- Reopening a conversation after server restart opens the same Pi session file.
- Multiple conversation runtimes can exist, while each conversation allows only
  one active run.
- Conversation streams emit typed envelopes with stable `runId`s.
- Conversation snapshots can rebuild the active timeline from Pi plus SQLite
  sidecar metadata.
- Invalid state transitions are rejected with stable `NelleError` codes.
- Done: aborting an active chat/regenerate run calls Pi abort, closes the llama
  proxy request, and emits `run.aborted`.
- `models.ini` can be parsed and written without dropping comments, unknown
  keys, or ordering in untouched sections.
- Migrations create backups before rewriting app data and fail into a repairable
  state.

### Phase 1: Router Metadata And `models.ini` Ownership

- Integrate the Phase 0 lossless `models.ini` parser/writer with the existing
  model APIs.
- Use the Phase 0 model id canonicalizer for HF imports and Pi model registry
  generation.
- Change `LlamaCppManager.start()` to start router mode without requiring an
  active model.
- Add configurable `modelsMax` and `sleepIdleSeconds`.
- Remove local path registration UI/API from the active product surface.
- Make HF import write `models.ini` sections directly.
- Make AppStore refresh model catalog state from parsed `models.ini` so manual
  INI edits, imports, edits, duplicates, and removals converge on the same
  source of truth.
- Add `/api/llama/models`, reload, load, unload, and events endpoints.
- Update Pi model generation to read from parsed `models.ini`.

Exit criteria:

- Start router with zero or more configured HF models.
- Importing an HF quant updates `models.ini`.
- Duplicate or invalid editable INI keys are surfaced before save.
- Imported HF refs keep exact `hf-repo` values and stable section ids.
- Running router reloads model list without restarting.
- Selecting an unloaded model loads it through router endpoints.
- Router-enforced `models-max` is reflected in UI status.

### Phase 2: Model Selector And Settings

- Done: build settings surface with Runtime, Models, Global Params, and Chats
  sections.
- Done: move HF search/import and param editing into Settings.
- Done for the compact composer selector: alias display, built-in search,
  browser-local favorite grouping, selected/row router status and progress, and
  load-before-activation for unloaded models.
- Done: add manual load/unload controls in Settings model rows.
- Done: fetch and cache loaded model props so the composer can display
  context-window metadata, gate image attachments, and show loaded-model
  context/modality metadata in selector rows.
- Done for Settings writes: alias/param edits, HF imports, duplicate/remove, and
  global param saves write `models.ini` and reload router models when running.
  Done: Settings rows for models with active runs show an active-run token and
  disable unload/save/remove until a terminal run event arrives.

Exit criteria:

- Done: users can edit global/model params without editing files.
- Done: users can see loaded/loading/unloaded/failed states in Settings rows.
- Done: composer model selector loads unloaded models before activation, supports
  search/favorites, and shows selected/row router status plus progress.
- Done: loaded model props expose context size and image-support capability in
  the composer and selector-row UI.
- Done: Settings edits/removals reload the running router and keep active runs
  captured by request-time model ids.

### Phase 3: Conversations And Sidebar

- Extend the existing SQLite conversation/index/projection storage and
  Pi-session binding into the final sidebar workflow.
- Complete replacement of legacy default-chat compatibility with
  conversation-scoped APIs throughout the UI and server.
- Use Pi session entries and leaf ids for active path and branch state. Do not
  duplicate Pi's tree as independent Nelle truth.
- Done in current pane: add collapsible conversation sidebar rail with new chat,
  search, pinned/recent section rows, TanStack-virtualized list, running status
  indicators, and item overflow menus, all hosted in an Astryx `SideNav` shell.
- Done in current row actions: pin/unpin, rename, reset, duplicate, and delete.
- Done: add conversation delete/pin/rename/duplicate.
- Done: add message-level fork into a new conversation, backed by Pi
  `SessionManager.createBranchedSession()`.
- Done: implement local `.nelle-chat.zip` export/import for conversation
  snapshots, Pi session files, attachments, and model manifest snapshots.
  `tool-audit.jsonl` includes persisted audit rows when host tools were used.
- Keep the visible branch UX scoped to active-path timelines, regenerate
  variants, fork, and duplicate. Do not build a full Pi tree explorer in v1.

Exit criteria:

- Done: multiple conversations persist and can be searched.
- Done: large conversation lists are rendered through a virtualized sidebar
  window instead of mounting every row.
- Active conversation can stream while another conversation is visible in the
  list with a running indicator.
- Forking from a persisted user message creates a new Nelle conversation with a
  new Pi session file and leaves the source conversation unchanged.
- Duplicating a conversation creates a new Nelle conversation from the active Pi
  branch.
- Done: exporting and importing a conversation round trips the Pi session file,
  Nelle sidecar metadata, attachments, and model manifest snapshots without
  overwriting existing conversations. Tool audit rows are exported when present;
  import keeps them as diagnostics rather than restoring them into the new
  conversation.
- Inactive Pi branches are preserved in session files and are not dropped by
  projection rebuilds.
- Done: conversation delete removes SQLite rows, the Pi session file, and
  unreferenced attachment files.

### Phase 3B: Assistant Footer Actions

- Done: persist `model_id`, `model_runtime_id`, and `model_alias_snapshot` on
  assistant messages.
- Done: replace the metadata footer string with a composed footer row
  containing timestamp, model dropdown, Reading/Generation statistics widget,
  copy, and regenerate controls.
- Done: replace the old throughput text with a Reading/Generation statistics
  widget that shows tokens, elapsed time, and speed for the active view.
- Done: add Pi-native model override regeneration through the assistant footer
  model selector. The current bounded load helper still polls `/api/llama/models`
  after requesting a load, while shared router display state also updates from
  the router SSE store.
- Done: add clipboard copy behavior for assistant messages.

Exit criteria:

- Done: every new assistant message shows the model that generated it.
- Done: selecting a different model from an assistant footer loads that model if
  needed and regenerates the answer in one action.
- Done: regeneration creates a Pi-native branch by replaying the original user
  content on a new branch, stores `regenerates_pi_entry_id` /
  `display_group_id` metadata, preserves existing answer variants in the visible
  projection, hides replayed duplicate user turns, and labels assistant variants
  in the footer.
- Done: copy writes the assistant text to the clipboard and surfaces visible
  toast feedback for success or failure.
- Done: timing metrics render as a toggleable Reading/Generation widget with
  icon controls and tooltips, without layout overflow on mobile or desktop
  widths.

### Phase 3C: Composer Attachments And Context Usage

- Done: add structured chat request attachments and message attachment
  persistence. Sent image binaries are stored content-addressed under
  `.nelle/attachments/`; text/PDF extracted text is stored inline up to the
  configured extraction cap.
- Done: add Astryx `ChatComposerDrawer` attachment chips/previews.
- Done: add file picker, drag/drop, and paste handling for text, PDF, and image
  files.
- Done: add PDF text extraction with `pdfjs-dist` and optional PDF-as-image
  conversion for vision models.
- Done: add attachment size/count/text extraction limits and content-hash
  storage. No server temp upload API exists yet; unsent drafts are client-only.
- Done: conversation hard delete removes the Pi session file and unreferenced
  attachment files.
- Done: export/import archives include referenced attachment files and restore
  them on import.
- Done: server startup sweeps orphan files under `.nelle/attachments/` when no
  SQLite attachment metadata references their `attachments/...` storage path.
- Done: gate image attachments and PDF-as-image mode on selected-model vision
  support from `/api/llama/models/:id/props`.
- Done: add composer `ProgressBar` for context-window usage with tooltip token
  counts. The UI fetches selected-model props for `n_ctx`, falls back to the
  configured model context size when props are unavailable, updates live from
  streamed llama.cpp performance metrics, and preserves last-known usage in
  conversation snapshots.
- Done for chat workflow: route chat send errors/warnings through
  `ChatComposer` status top/bottom positions. Runtime/setup notices outside
  chat can still use page-level notices.

Exit criteria:

- Done: text and PDF-as-text attachments work with text-only models.
- Done: attachment limits are enforced with composer status messages. No
  abandoned server temp uploads exist in this implementation because drafts stay
  client-only until send.
- Done: image attachments and PDF-as-image mode are enabled only for
  vision-capable models.
- Done: audio/video attachments are not exposed.
- Done: switching models revalidates pending image attachments through composer
  status before send.
- Done: the composer shows a live/last-known context progress bar with
  token-count tooltip.
- Done for chat workflow: llama-server stopped, no model selected, unsupported
  slash commands, chat stream errors, and context overflow appear as top
  composer errors.
- Done: near-full context and non-blocking attachment conversion/truncation
  warnings appear as bottom composer warnings.

### Phase 3D: Slash Commands And Manual Compaction

- Done: add an Astryx `ChatComposerInput` slash-command trigger backed by
  Nelle's command allowlist.
- Done: support `/compact [instructions]` for the active conversation.
- Done: add the conversation-scoped compaction API and Pi bridge adapter.
- Done: add command/status rows for compaction progress, completion, abort, and
  failure. These rows are local UI rows and are not persisted as normal
  user/assistant messages.
- Done: reject unsupported Pi slash commands with composer errors that point to
  the Nelle UI equivalent and preserve the submitted draft.
- Done: add a small command help surface in the composer footer for `/compact`.
  Unsupported UI-owned Pi commands are explained through composer errors.

Exit criteria:

- Done: typing `/` opens an Astryx-styled command typeahead showing `/compact`.
- Done: `/compact` and `/compact <instructions>` run manual compaction for the
  active idle conversation and display visible progress/completion/failure rows.
- Done: `/compact` uses the compact SSE endpoint with stable compact run ids,
  `compact.started`, `compact.completed`, and `compact.failed` events.
- Done: unsupported commands such as `/new`, `/resume`, `/model`, `/login`, and
  `/logout` are never sent to Pi as prompts and show actionable UI guidance.
- Done: compaction completion stores a llama.cpp `/tokenize` context estimate,
  emits `context.updated`, and re-applies the conversation snapshot so the
  context-window display refreshes with persisted used/total token counts.
- Done: manual compaction uses Pi `AgentSession.compact()` and stop prefers the
  run abort endpoint, which calls `AgentSession.abortCompaction()` server-side.

### Phase 4: Title Generation

- Done: add non-persisted title-generation request after first response.
- Done: add safeguards for user-edited/imported titles.
- Done: add tests for success, failure fallback, skip conditions, and
  no-history pollution.
- Done: emit title-generation run lifecycle events and route title-run aborts
  through the run abort endpoint without changing foreground conversation
  status.

Exit criteria:

- Done: new conversations receive concise generated titles after first response.
- Done: the title prompt is never persisted or sent through Pi tools.

## Testing Strategy

Unit tests:

- Event envelope and `NelleError` schema validation.
- Transport envelope helpers for SSE serialization and snapshot refetch
  recovery assumptions.
- `models.ini` AST parse/write, including comment/order/unknown key
  preservation, duplicate editable-key detection, atomic-write failure handling,
  and malformed-line round trips.
- `models.ini` source-of-truth behavior over stale `state.json`, direct HF
  import writes, and full-replacement free-form model param saves.
- HF import section generation and stable model id canonicalization, including
  `UD-` quant normalization and collision hash suffixes.
- Global and per-model param validation.
- Router event normalization.
- Router/model race policy reducers for selected-model removal, LRU unload,
  reload after edit, and active-run model immutability.
- Pi event mapping into Nelle stream events, including unknown-event tolerance.
- Conversation/run state machine transitions and `conversation_busy` errors.
- Conversation snapshot building from Pi entries plus SQLite sidecar metadata.
- Pi session projection sync from entry lists, leaf id changes, and missing
  session-file handling.
- Conversation title sanitization/fallback.
- Message model metadata selection and alias snapshot fallback.
- Fork/clone request validation, source entry eligibility, new conversation
  metadata, and default title generation.
- Branch/variant grouping from `display_group_id` without dropping inactive Pi
  branches.
- Regenerate request path construction, branch creation, and model override
  validation.
- Performance statistics view selection, formatting, and live auto-switching.
- Clipboard text formatting.
- Sidebar row flattening, stable virtual keys, and search/pinned grouping.
- Attachment file classification, size/count limits, content-hash storage,
  modality gating, PDF/text extraction fallback, temp cleanup, and
  context-progress formatting.
- Done: export/import archive manifest validation, path traversal rejection,
  checksum validation, and sidecar metadata overlay by Pi entry id.
- Migration runner backup creation, idempotent retry behavior, and failed
  migration repair state.
- Tool audit event persistence and deletion/export behavior.
- Host-tool Settings acknowledgement/default-disabled behavior and global
  enable/disable reset behavior.
- Slash-command parsing, Nelle allowlist/blocklist behavior, unsupported
  command guidance, and `/compact` instruction extraction.

Integration tests:

- Create a conversation, verify a Pi session file is created, restart the Nelle
  server, reopen the conversation, and verify the same Pi session file/id is
  used.
- Fork a conversation from a persisted Pi user entry and verify a new Pi session
  file plus Nelle conversation row are created while the source conversation is
  unchanged.
- Duplicate a conversation active branch and verify the new conversation points
  to a new Pi session file with cloned active-path content.
- Open two conversations and stream one request in each, verifying Nelle permits
  multiple conversation runtimes but rejects a second active run in the same
  conversation.
- Abort a chat run and verify Nelle calls Pi abort, closes the llama proxy
  request, emits `run.aborted`, and refreshes the conversation projection.
- Mock router endpoints for `/props`, `/models`, `/models/load`,
  `/models/unload`, `/models/sse`.
- Mock per-model `/props?model=<id>&autoload=false` for context size and
  modalities.
- Verify selector calls load and updates status from SSE.
- Verify `models-max` is displayed from `/props`.
- Verify editing `models.ini` calls reload when router is running.
- Verify removing or editing a selected/loaded model follows the router/model
  race policy and does not mutate active runs.
- Verify regenerate with a model override calls router load when needed and
  streams with the selected model.
- Verify regenerate preserves the old answer, replays the original user content
  on a Pi-native branch, and groups the new answer as a UI variant.
- Verify prompt/generation metric mapping from streamed `prompt_progress` and
  `timings`.
- Verify structured text/image content is preserved through Pi when the model
  supports image input, and rejected through composer status when it does not.
- Verify context overflow errors with `n_prompt_tokens`/`n_ctx` become composer
  top errors.
- Verify exported `.nelle-chat.zip` archives import as new conversations and
  preserve Pi history, Nelle sidecar metadata, attachments, and tool audit rows.
- Verify host-tool calls create audit rows and disabled tools fail closed with
  `tools_disabled`.
- Verify migration from `.nelle/state.json` creates backups, converts supported
  data, drops local-path models from active state, and leaves failed migrations
  repairable.
- Verify `/compact` calls `AgentSession.compact()` for the active conversation,
  compaction stop calls `AgentSession.abortCompaction()`, unsupported slash
  commands are rejected before Pi prompt submission, and busy conversations
  reject compaction with composer status.

Playwright tests:

- New chat creates a durable conversation that survives server restart.
- Starting generation in one conversation does not block viewing or starting an
  allowed run in another conversation.
- Pressing stop aborts generation, clears active-run model locks, shows
  composer-local stopped feedback, and leaves the composer usable.
- Settings HF import writes `models.ini` and model appears in selector.
- Selecting an unloaded model shows loading progress then selected loaded model.
- Sidebar creates, searches, pins, renames, exports, and deletes conversations.
- Importing a `.nelle-chat.zip` archive creates a new conversation and does not
  overwrite an existing one.
- Sidebar duplicate creates a copied conversation without mutating the source.
- User message fork action creates a new forked conversation and opens/selects
  it according to the current UI routing decision.
- Composer stays docked while message list scrolls.
- Virtualized list remains responsive with thousands of conversations and keeps
  the mounted sidebar row count bounded.
- Virtualized sidebar overflow menus, keyboard focus, and active-row scrolling
  keep working after large scroll jumps.
- Assistant footer shows timestamp, model label/dropdown, Reading/Generation
  statistics, copy, and regenerate.
- Statistics toggles switch between prompt tokens/time/speed and generated
  tokens/time/speed.
- Statistics icons expose hover/focus tooltip text for every metric.
- Selecting a different footer model regenerates with that model and keeps the
  new model label on the regenerated answer.
- Copy button writes assistant text to the clipboard.
- Attachment drawer adds/removes text, PDF, and image files; unsupported images
  are blocked for text-only models.
- Attachment size/count/unsupported-type failures appear in composer status and
  do not send a partial prompt silently.
- Context progress bar tooltip shows used/total token counts and warning/error
  status at the configured thresholds.
- First-run host-tool acknowledgement appears before host tools are enabled,
  and tool rows expose expandable input/output details.
- Composer shows llama-server stopped/no model/unsupported attachment as top
  status errors and near-full context as a bottom status warning.
- Typing `/` shows the slash-command typeahead, selecting `/compact` inserts the
  command token/draft, and submitting it renders compaction progress.
- Typing unsupported commands such as `/model` or `/new` shows composer guidance
  and does not append a normal chat message.
- Title generation updates only the conversation title, not message history.

## Risks And Decisions

- `models.ini` round-trip: use the planned lossless AST writer. The main risk is
  matching llama.cpp's permissive parsing closely enough while preserving
  malformed or advanced user edits.
- Model id canonicalization: section ids stay stable and exact HF refs stay in
  `hf-repo`; router-reported ids are cached separately. The main risk is
  unusual GGUF filename patterns, handled by collision hashing and preserving
  exact refs.
- Historical model display: message footers must keep a model alias snapshot so
  renamed or removed models do not make old answers ambiguous.
- Regeneration semantics: use Pi-native branching by replaying the original user
  content on a new branch. The UI groups regenerated answers as variants, so
  users do not need to understand the duplicated Pi user entry.
- Fork/clone semantics: Nelle implements these as new conversations backed by
  new Pi session files. Use `SessionManager.createBranchedSession()` directly
  so source conversation state is not replaced by Pi's runtime-level fork
  operation.
- Running router reload: changing or removing a loaded section can trigger
  unload. The UI must warn before destructive model edits, disable destructive
  edits while active runs use that model, and treat router status as
  authoritative after reload.
- Local path migration: local path model entries are removed from active state,
  so backup state should remain available until the SQLite migration is proven.
- SQLite source-of-truth boundary: Pi session files own message history and
  tree state; SQLite projection rows are cache/sidecar data and must be
  rebuildable.
- Snapshot contract: clients recover from stream disconnects by refetching
  snapshots. Durable event replay is intentionally deferred.
- Transport: v1 browser uses REST plus SSE. WebSocket remains available as a
  future mobile/background transport only if it carries the same event envelope.
- Pi event mapping: unknown Pi events must be ignored safely and logged until
  Nelle explicitly supports them.
- State machine: each conversation has at most one active run. Cross-conversation
  concurrency is allowed, but same-conversation sends/compactions fail with
  `conversation_busy`.
- Done: abort propagation preserves close/abort signals through the llama proxy.
  Abort endpoints also run a best-effort `/slots` grace check and warn if a slot
  keeps generating rather than killing llama.cpp automatically.
- Attachment token estimates: text-only `/tokenize` estimates are useful for
  draft UI but not authoritative for multimodal prompts or full chat history.
  Streamed `prompt_progress` and final `timings` remain authoritative.
- Attachment storage: content-addressed files and conservative upload limits
  reduce accidental disk growth, but the first implementation still needs temp
  cleanup and import path validation.
- Tool security: v1 host tools are unsandboxed. The implementation must require
  explicit acknowledgement, expose a disable switch, render tool input/output,
  and keep an audit trail until a stronger permission/sandbox model exists.
- Export/import: archives are local `.nelle-chat.zip` bundles with Pi session
  files plus Nelle sidecar metadata. They must not include model weights,
  secrets, pairing tokens, or absolute local paths.
- Migration safety: migrations create timestamped backups and fail into a
  repairable setup state rather than partially rewriting conversations.
- Title generation cost: it adds one extra model call on new conversations.
  Keep it short and make failures silent.
- Pi slash-command boundary: Pi owns many interactive commands that conflict
  with Nelle's UI-owned model/session/auth/settings flows. Keep the chat
  allowlist narrow, support `/compact` first, and do not expose extension, skill,
  or prompt-template slash commands until Nelle has explicit command-level
  policy.
- Pi compaction integration: implement manual compaction with
  `AgentSession.compact()` and compaction stop with
  `AgentSession.abortCompaction()`. Do not route built-in `/compact` through
  normal prompt submission.

## Settled Follow-Up Decisions

- `modelsMax` defaults to `1`, is user-configurable, and requires a
  `llama-server` restart.
- `sleepIdleSeconds` defaults to `90`, is user-configurable, and requires a
  `llama-server` restart.
- Model/global parameter editing starts as free-form key/value UI only. Invalid
  parameters should fail through llama-server, and Nelle exposes the
  llama-server log tail for diagnosis.
- Do not expose llama.cpp's cache-sourced `POST /models` import path for normal
  Nelle imports; `models.ini` stays authoritative.
- Conversation delete is a hard delete for now.
- Local file model APIs are removed now, not just hidden.
- Composer attachments are text, PDF, and image only for now. Audio/video are
  excluded while the Pi integration path is text plus image.
- Only `/compact [instructions]` is supported as a Pi slash command in Nelle's
  chat composer initially. All other Pi built-ins are either handled through
  Nelle UI surfaces or intentionally unsupported until explicitly allowlisted.
- Each Nelle conversation maps to exactly one Pi session file. Pi owns message
  history, compaction, and the branch tree; SQLite owns Nelle's index,
  projections, and sidecar UI metadata.
- Multiple Pi conversation runtimes may be active simultaneously when Pi and the
  local router can support them. Nelle only forbids concurrent runs within the
  same conversation.
- The v1 browser transport is REST for commands/snapshots and SSE for
  conversation, router, runtime, log-tail, and install/build events.
- Conversation snapshots are the recovery source after stream disconnects; v1
  does not require durable event replay.
- Fork and duplicate are in scope for the conversation UI. Both use Pi
  `SessionManager.createBranchedSession()` to create new Nelle conversations
  rather than mutating or replacing the source conversation.
- The v1 branch UI shows the active Pi path, regenerate variants, fork, and
  duplicate. A full Pi tree explorer is deferred, but inactive Pi branches must
  remain preserved in session files.
- UI stop/abort calls Pi `AgentSession.abort()` and propagates abort to the
  llama.cpp proxy request. Nelle does not auto-kill llama.cpp unless the user
  explicitly chooses a runtime stop/restart action.
- Host file/shell tools require explicit first-run acknowledgement, remain
  globally disableable, and persist audit rows until sandboxing/per-tool
  permissions are designed.
- Conversation export/import uses local `.nelle-chat.zip` archives and imports
  always create new Nelle conversations.
- Database migrations use `schema_migrations`, timestamped backups, and
  repairable failure behavior.
